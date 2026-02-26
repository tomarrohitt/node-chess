import { db } from "../../infrastructure/db/db";
import { games, user } from "../../infrastructure/db/schema";
import { redis } from "../../infrastructure/redis/redis-client";
import { GameResult, GameStatus } from "../../types/types";
import { Keys } from "../../lib/keys";
import { eq, InferInsertModel, sql } from "drizzle-orm";
import { calculateNewRatings } from "../../lib/elo";

export async function flushGameToDatabase(
  gameId: string,
  status: GameStatus,
  winnerId?: string,
): Promise<void> {
  const gameKey = Keys.game(gameId);
  const gameState = await redis.hgetall(gameKey);

  if (!gameState.whiteId || !gameState.blackId || !gameState.fen) {
    console.error(
      `[Storage] Missing critical data for game ${gameId} — skipping DB flush`,
    );
    return;
  }

  const [whiteUser, blackUser] = await Promise.all([
    db.query.user.findFirst({
      where: eq(user.id, gameState.whiteId),
    }),
    db.query.user.findFirst({
      where: eq(user.id, gameState.blackId),
    }),
  ]);

  if (!whiteUser || !blackUser) {
    console.error("[Storage] Could not find users in DB for rating update");
    return;
  }

  const scoreA =
    winnerId === whiteUser.id ? 1 : winnerId === blackUser.id ? 0 : 0.5;

  const { diffA, diffB, newRatingA, newRatingB } = calculateNewRatings(
    whiteUser.rating,
    blackUser.rating,
    scoreA,
  );

  const resultSymbol =
    winnerId === whiteUser.id
      ? "1-0"
      : winnerId === blackUser.id
        ? "0-1"
        : "1/2-1/2";

  let finalPgn = (gameState.pgn ?? "").trim().replace(/\*$/, resultSymbol);

  if (!finalPgn.includes(`[Result "${resultSymbol}"]`)) {
    finalPgn = finalPgn.replace(
      /\[Result ".*?"\]/,
      `[Result "${resultSymbol}"]`,
    );
  }

  const newGame: InferInsertModel<typeof games> = {
    id: gameId,
    whiteId: gameState.whiteId,
    blackId: gameState.blackId,
    winnerId: winnerId ?? null,
    status,
    result: winnerId
      ? winnerId === whiteUser.id
        ? GameResult.w
        : GameResult.b
      : GameResult.d,
    timeControl: gameState.timeControl,
    pgn: finalPgn,
    finalFen: gameState.fen!,
    whiteTimeLeftMs: parseInt(gameState.whiteTimeLeftMs ?? "0", 10),
    blackTimeLeftMs: parseInt(gameState.blackTimeLeftMs ?? "0", 10),
    moveTimes: JSON.parse(gameState.moveTimes ?? "[]"),

    whiteRating: whiteUser.rating,
    blackRating: blackUser.rating,

    whiteDiff: diffA,
    blackDiff: diffB,
  };
  try {
    await db.transaction(async (tx) => {
      await tx.insert(games).values(newGame);

      await tx
        .update(user)
        .set({
          rating: newRatingA,
          wins: winnerId === whiteUser.id ? sql`${user.wins} + 1` : user.wins,
          losses:
            winnerId === blackUser.id ? sql`${user.losses} + 1` : user.losses,
          draws: !winnerId ? sql`${user.draws} + 1` : user.draws,
        })
        .where(eq(user.id, whiteUser.id));

      await tx
        .update(user)
        .set({
          rating: newRatingB,
          wins: winnerId === blackUser.id ? sql`${user.wins} + 1` : user.wins,
          losses:
            winnerId === whiteUser.id ? sql`${user.losses} + 1` : user.losses,
          draws: !winnerId ? sql`${user.draws} + 1` : user.draws,
        })
        .where(eq(user.id, blackUser.id));
    });

    await Promise.all([
      redis.del(gameKey),
      redis.del(Keys.userActiveGame(whiteUser.id)),
      redis.del(Keys.userActiveGame(blackUser.id)),
    ]);
  } catch (error) {
    console.error(`[Storage] Failed to flush game ${gameId} to DB:`, error);
  }
}

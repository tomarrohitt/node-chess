import { eq, or, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { games, user } from "../../infrastructure/db/schema";
import { db } from "../../infrastructure/db/db";

export async function getUserMatchHistory(userId: string, limit = 20) {
  const whitePlayer = alias(user, "whitePlayer");
  const blackPlayer = alias(user, "blackPlayer");

  const results = await db
    .select({
      id: games.id,
      status: games.status,
      timeControl: games.timeControl,
      createdAt: games.createdAt,
      winnerId: games.winnerId,
      white: {
        username: whitePlayer.username,
        rating: whitePlayer.rating,
      },
      black: {
        username: blackPlayer.username,
        rating: blackPlayer.rating,
      },
    })
    .from(games)
    .leftJoin(whitePlayer, eq(games.whiteId, whitePlayer.id))
    .leftJoin(blackPlayer, eq(games.blackId, blackPlayer.id))
    .where(or(eq(games.whiteId, userId), eq(games.blackId, userId)))
    .orderBy(desc(games.createdAt))
    .limit(limit);

  return results.map((game) => {
    let outcome: "WON" | "LOST" | "DRAW" = "DRAW";

    if (game.winnerId === userId) {
      outcome = "WON";
    } else if (game.winnerId && game.winnerId !== userId) {
      outcome = "LOST";
    }

    return {
      ...game,
      outcome,
    };
  });
}

export async function getGameDetails(gameId: string) {
  const whitePlayer = alias(user, "whitePlayer");
  const blackPlayer = alias(user, "blackPlayer");

  const game = await db
    .select({
      id: games.id,
      status: games.status,
      pgn: games.pgn,
      finalFen: games.finalFen,
      white: { username: whitePlayer.username, rating: whitePlayer.rating },
      black: { username: blackPlayer.username, rating: blackPlayer.rating },
    })
    .from(games)
    .leftJoin(whitePlayer, eq(games.whiteId, whitePlayer.id))
    .leftJoin(blackPlayer, eq(games.blackId, blackPlayer.id))
    .where(eq(games.id, gameId))
    .limit(1);

  return game[0] ?? null;
}

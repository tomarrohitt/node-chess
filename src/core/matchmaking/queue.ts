import { v7 as uuidv7 } from "uuid";
import { redis } from "../../infrastructure/redis/redis-client";
import { sendToUser } from "../../infrastructure/ws/session-manager";
import { startPlayerTimer } from "../game/timer";
import { WsMessageType, GameStatus } from "../../types/types";
import { Keys } from "../../lib/keys";
import { db } from "../../infrastructure/db/db";
import { user } from "../../infrastructure/db/schema";
import { eq } from "drizzle-orm";

const MATCHMAKING_QUEUE_KEY = "matchmaking:queue";

const CLAIM_OPPONENT_LUA = `
local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2], 'LIMIT', 0, 1)
if #candidates > 0 then
  local opponentId = candidates[1]
  if opponentId ~= ARGV[3] then
    redis.call('ZREM', KEYS[1], opponentId)
    return opponentId
  end
end
return nil
`;

function parseTimeControl(tc: string): { baseMs: number } {
  const [minsPart] = tc.split("+");
  const mins = parseInt(minsPart ?? "", 10);
  if (isNaN(mins)) throw new Error(`Invalid time control: ${tc}`);
  return { baseMs: mins * 60 * 1000 };
}

export async function handleJoinQueue(
  userId: string,
  timeControl: string,
): Promise<void> {
  const LOCK_KEY = `lock:matchmaking:${userId}`;
  const isSearching = await redis.set(LOCK_KEY, "locked", "EX", 45, "NX");

  if (!isSearching) {
    console.warn(
      `[Queue] ${userId} already has an active search loop. Ignoring.`,
    );
    return;
  }

  try {
    const userData = await db.query.user.findFirst({
      where: eq(user.id, userId),
    });
    const rating = userData?.rating ?? 1000;

    await redis.zadd(MATCHMAKING_QUEUE_KEY, rating, userId);

    const searchTiers = [100, 300, 500, 1000, 1500];

    for (const range of searchTiers) {
      const stillInQueue = await redis.zscore(MATCHMAKING_QUEUE_KEY, userId);

      if (!stillInQueue) {
        return;
      }

      const minRating = rating - range;
      const maxRating = rating + range;

      const opponentId = (await redis.eval(
        CLAIM_OPPONENT_LUA,
        1,
        MATCHMAKING_QUEUE_KEY,
        minRating.toString(),
        maxRating.toString(),
        userId,
      )) as string | null;

      if (opponentId) {
        await redis.zrem(MATCHMAKING_QUEUE_KEY, userId);

        await createNewMatch(userId, opponentId, timeControl);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    const finalCheck = await redis.zrem(MATCHMAKING_QUEUE_KEY, userId);
    if (finalCheck) {
      await sendToUser(userId, {
        type: WsMessageType.MATCHMAKING_TIMEOUT,
        payload: { message: "No suitable opponent found. Try again?" },
      });
    }
  } finally {
    await redis.del(LOCK_KEY);
  }
}

export async function handleLeaveQueue(userId: string): Promise<void> {
  await redis.zrem(MATCHMAKING_QUEUE_KEY, userId);

  await sendToUser(userId, {
    type: WsMessageType.QUEUE_LEFT,
    payload: { status: "idle" },
  });
}

async function createNewMatch(
  player1: string,
  player2: string,
  timeControl: string,
): Promise<void> {
  const gameId = uuidv7();
  const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const { baseMs } = parseTimeControl(timeControl);
  const now = Date.now();

  const isP1White = Math.random() > 0.5;
  const whiteId = isP1White ? player1 : player2;
  const blackId = isP1White ? player2 : player1;

  await redis.hset(Keys.game(gameId), {
    whiteId,
    blackId,
    fen: initialFen,
    pgn: "",
    status: GameStatus.IN_PROGRESS,
    turn: "w",
    timeControl,
    whiteTimeLeftMs: baseMs,
    blackTimeLeftMs: baseMs,
    lastMoveTimestamp: now,
  });

  console.log(
    `[Game] Started | ID: ${gameId} | ${whiteId} (W) vs ${blackId} (B)`,
  );

  await Promise.all([
    redis.set(Keys.userActiveGame(whiteId), gameId),
    redis.set(Keys.userActiveGame(blackId), gameId),
  ]);

  const whitePlayerPayload = {
    type: WsMessageType.GAME_STARTED,
    payload: {
      gameId,
      fen: initialFen,
      timeControl,
      color: "white",
      players: { white: whiteId, black: blackId },
    },
  };
  const blackPlayerPayload = {
    type: WsMessageType.GAME_STARTED,
    payload: {
      gameId,
      fen: initialFen,
      timeControl,
      color: "black",
      players: { white: whiteId, black: blackId },
    },
  };

  await Promise.all([
    sendToUser(whiteId, whitePlayerPayload),
    sendToUser(blackId, blackPlayerPayload),
  ]);

  await startPlayerTimer(gameId, whiteId, blackId, baseMs);
}

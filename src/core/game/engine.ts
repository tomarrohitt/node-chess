import { Chess } from "chess.js";
import {
  NotYourTurnError,
  TimeExpiredError,
  IllegalMoveError,
} from "../../lib/errors";
import { GameState, getIncrementMs, parseGameState } from "../../lib/state";
import { GameStatus, WsMessageType } from "../../types/events";
import { Keys } from "../../lib/keys";
import { redis } from "../../infrastructure/redis/redis-client";
import { cancelTimer, startPlayerTimer } from "./timer";
import { flushGameToDatabase } from "./storage";
import { sendToUser } from "../../infrastructure/ws/session-manager";

/**
 * Converts milliseconds to PGN clock format [H:MM:SS]
 */
function formatPgnTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `0:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function validateTurn(state: GameState, userId: string): boolean {
  const isWhiteTurn = state.turn === "w";
  const expectedId = isWhiteTurn ? state.whiteId : state.blackId;
  if (userId !== expectedId) throw new NotYourTurnError();
  return isWhiteTurn;
}

function calculateClocks(
  state: GameState,
  now: number,
): { whiteTime: number; blackTime: number; elapsed: number } {
  const elapsed = now - state.lastMoveTimestamp;
  const incMs = getIncrementMs(state.timeControl);
  const isWhiteTurn = state.turn === "w";

  let { whiteTimeLeftMs: whiteTime, blackTimeLeftMs: blackTime } = state;

  if (isWhiteTurn) {
    whiteTime -= elapsed;
    if (whiteTime <= 0) throw new TimeExpiredError();
    whiteTime += incMs;
  } else {
    blackTime -= elapsed;
    if (blackTime <= 0) throw new TimeExpiredError();
    blackTime += incMs;
  }

  return { whiteTime, blackTime, elapsed };
}

function applyMove(
  state: GameState,
  from: string,
  to: string,
  remainingTimeMs: number,
  promotion?: string,
): { chess: Chess; san: string } {
  const chess = new Chess();
  if (state.pgn) chess.loadPgn(state.pgn);

  try {
    const result = chess.move({ from, to, promotion });
    chess.setComment(`[%clk ${formatPgnTime(remainingTimeMs)}]`);
    return { chess, san: result.san };
  } catch {
    throw new IllegalMoveError();
  }
}

function resolveOutcome(
  chess: Chess,
  state: GameState,
): { status: GameStatus; winnerId?: string; isOver: boolean; reason?: string } {
  if (!chess.isGameOver()) {
    return { status: GameStatus.IN_PROGRESS, isOver: false };
  }

  if (chess.isCheckmate()) {
    // If turn is now 'b', White delivered mate.
    const whiteWon = chess.turn() === "b";
    return {
      status: whiteWon ? GameStatus.WHITE_WON : GameStatus.BLACK_WON,
      winnerId: whiteWon ? state.whiteId : state.blackId,
      isOver: true,
      reason: "checkmate",
    };
  }

  // Draw conditions
  let reason = "draw";
  if (chess.isStalemate()) reason = "stalemate";
  if (chess.isThreefoldRepetition()) reason = "repetition";
  if (chess.isInsufficientMaterial()) reason = "insufficient material";
  if (chess.isDraw()) reason = "50-move rule";

  return { status: GameStatus.DRAW, isOver: true, reason };
}

export async function processMove(
  gameId: string,
  userId: string,
  from: string,
  to: string,
  promotion?: string,
) {
  const gameKey = Keys.game(gameId);
  const raw = await redis.hgetall(gameKey);
  const state = parseGameState(raw, gameId);

  // 1. Validate turn and calculate time
  const isWhiteTurn = validateTurn(state, userId);
  const now = Date.now();
  const { whiteTime, blackTime, elapsed } = calculateClocks(state, now);

  // 2. Apply move with clock comment
  const playerRemainingTime = isWhiteTurn ? whiteTime : blackTime;
  const { chess, san } = applyMove(
    state,
    from,
    to,
    playerRemainingTime,
    promotion,
  );

  const moveTimes = JSON.parse(raw.moveTimes || "[]");
  moveTimes.push(elapsed);

  const { status, winnerId, isOver, reason } = resolveOutcome(chess, state);
  // MOVE LOG
  console.log(
    `[Move] ${userId.slice(0, 5)}: ${from}->${to} | Clocks W: ${Math.floor(whiteTime / 1000)}s, B: ${Math.floor(blackTime / 1000)}s`,
  );

  await cancelTimer(gameId);

  await redis.hset(gameKey, {
    fen: chess.fen(),
    pgn: chess.pgn(),
    turn: chess.turn(),
    status,
    whiteTimeLeftMs: whiteTime,
    blackTimeLeftMs: blackTime,
    lastMoveTimestamp: now,
    moveTimes: JSON.stringify(moveTimes),
  });

  if (isOver) {
    console.log(
      `[Engine] Game Over: ${reason} | Winner: ${winnerId ?? "None"}`,
    );
    await flushGameToDatabase(gameId, status, winnerId);

    const gameOverPayload = {
      type: WsMessageType.GAME_OVER,
      payload: { status, winnerId, reason },
    };

    await Promise.all([
      sendToUser(state.whiteId, gameOverPayload),
      sendToUser(state.blackId, gameOverPayload),
    ]);
  } else {
    const nextId = chess.turn() === "w" ? state.whiteId : state.blackId;
    const prevId = chess.turn() === "w" ? state.blackId : state.whiteId;
    const nextTime = chess.turn() === "w" ? whiteTime : blackTime;
    await startPlayerTimer(gameId, nextId, prevId, nextTime);
  }

  return {
    newFen: chess.fen(),
    move: san,
    isGameOver: isOver,
    moveTimes,
    whiteId: state.whiteId,
    blackId: state.blackId,
  };
}

export async function handleAbort(gameId: string, userId: string) {
  const gameKey = Keys.game(gameId);
  const raw = await redis.hgetall(gameKey);
  const moveTimes = JSON.parse(raw.moveTimes || "[]");

  if (moveTimes.length >= 2) {
    throw new Error(
      "Game cannot be aborted after 2 moves. Use Resign instead.",
    );
  }

  await Promise.all([
    redis.del(gameKey),
    redis.del(Keys.userActiveGame(raw.whiteId)),
    redis.del(Keys.userActiveGame(raw.blackId)),
    cancelTimer(gameId),
  ]);

  console.log(`[Game] Aborted | ID: ${gameId.slice(0, 8)}`);

  const payload = { type: WsMessageType.GAME_ABORTED, payload: { gameId } };
  await Promise.all([
    sendToUser(raw.whiteId, payload),
    sendToUser(raw.blackId, payload),
  ]);
}

export async function handleDrawOffer(gameId: string, userId: string) {
  const drawKey = `draw_offer:${gameId}`;

  const existingOfferBy = await redis.get(drawKey);

  if (existingOfferBy) {
    return await sendToUser(userId, {
      type: WsMessageType.ERROR,
      payload: "A draw offer is already pending.",
    });
  }

  const raw = await redis.hgetall(Keys.game(gameId));
  if (!raw.whiteId) return;

  const opponentId = userId === raw.whiteId ? raw.blackId : raw.whiteId;

  await redis.set(drawKey, userId, "EX", 20);

  await sendToUser(opponentId, {
    type: WsMessageType.DRAW_OFFERED,
    payload: {
      gameId,
      offeredBy: userId,
      expiresAt: Date.now() + 20000,
    },
  });

  console.log(
    `[Game] Draw Offered | By: ${userId.slice(0, 5)}... to ${opponentId.slice(0, 5)}...`,
  );
}
export async function handleDrawAccept(gameId: string, userId: string) {
  const drawKey = `draw_offer:${gameId}`;
  const offeringUserId = await redis.get(drawKey);

  if (!offeringUserId || offeringUserId === userId) {
    throw new Error("No valid draw offer found to accept.");
  }

  const status = GameStatus.DRAW;
  await flushGameToDatabase(gameId, status, undefined);
  const payload = {
    type: WsMessageType.GAME_OVER,
    payload: { status, reason: "agreement" },
  };
  const raw = await redis.hgetall(Keys.game(gameId));

  await Promise.all([
    sendToUser(raw.whiteId, payload),
    sendToUser(raw.blackId, payload),
    redis.del(drawKey),
  ]);
  console.log(`[Game] Draw Accepted | Agreement by both players`);
}

export async function handleDrawDecline(gameId: string, userId: string) {
  const drawKey = `draw_offer:${gameId}`;
  const offeringUserId = await redis.get(drawKey);

  if (!offeringUserId) {
    return;
  }

  if (offeringUserId === userId) return;

  await redis.del(drawKey);

  await sendToUser(offeringUserId, {
    type: "DRAW_DECLINED",
    payload: { gameId, message: "Your opponent declined the draw offer." },
  });

  console.log(`[Game] Draw Declined | ID: ${gameId.slice(0, 8)}`);
}

export async function handleDrawExpire(gameId: string) {
  const drawKey = `draw_offer:${gameId}`;
  await redis.del(drawKey);
}

export async function getSyncState(userId: string) {
  const gameId = await redis.get(Keys.userActiveGame(userId));
  if (!gameId) return null;

  const gameState = await redis.hgetall(Keys.game(gameId));
  if (!gameState || Object.keys(gameState).length === 0) return null;

  if (gameState.status !== GameStatus.IN_PROGRESS) {
    await redis.del(Keys.userActiveGame(userId));
    return null;
  }

  const now = Date.now();
  const lastMoveAt = parseInt(gameState.lastMoveTimestamp || "0", 10);
  const elapsed = now - lastMoveAt;

  let whiteTime = parseInt(gameState.whiteTimeLeftMs || "0", 10);
  let blackTime = parseInt(gameState.blackTimeLeftMs || "0", 10);

  if (lastMoveAt > 0) {
    if (gameState.turn === "w") whiteTime -= elapsed;
    else blackTime -= elapsed;
  }

  if (whiteTime <= 0 || blackTime <= 0) {
    const winnerId = whiteTime <= 0 ? gameState.blackId : gameState.whiteId;
    await flushGameToDatabase(gameId, GameStatus.TIME_OUT, winnerId);
    return null;
  }

  return {
    gameId,
    fen: gameState.fen,
    pgn: gameState.pgn,
    turn: gameState.turn,
    status: gameState.status,
    whiteId: gameState.whiteId,
    blackId: gameState.blackId,
    timeControl: gameState.timeControl,
    whiteTimeLeftMs: whiteTime,
    blackTimeLeftMs: blackTime,
  };
}

import { Chess } from "chess.js";
import { NotYourTurnError, IllegalMoveError } from "../../lib/errors";
import { GameState, getIncrementMs, parseGameState } from "../../lib/state";
import { GameStatus, WsMessageType } from "../../types/types";
import { Keys } from "../../lib/keys";
import { redis } from "../../infrastructure/redis/redis-client";
import { cancelTimer, startPlayerTimer } from "./timer";
import { flushGameToDatabase } from "./storage";
import { sendToUser } from "../../infrastructure/ws/session-manager";

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

function calculateClocks(state: GameState, now: number) {
  const elapsed = now - state.lastMoveTimestamp;
  const incMs = getIncrementMs(state.timeControl);
  const isWhiteTurn = state.turn === "w";

  let { whiteTimeLeftMs: whiteTime, blackTimeLeftMs: blackTime } = state;
  let isTimeout = false;

  if (isWhiteTurn) {
    whiteTime -= elapsed;
    if (whiteTime <= 0) isTimeout = true;
    else whiteTime += incMs;
  } else {
    blackTime -= elapsed;
    if (blackTime <= 0) isTimeout = true;
    else blackTime += incMs;
  }

  return { whiteTime, blackTime, elapsed, isTimeout };
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
    const whiteWon = chess.turn() === "b";
    const winnerId = whiteWon ? state.whiteId : state.blackId;

    return {
      status: GameStatus.CHECKMATE,
      winnerId,
      isOver: true,
      reason: "checkmate",
    };
  }

  if (chess.isStalemate()) {
    return { status: GameStatus.STALEMATE, isOver: true, reason: "stalemate" };
  }

  if (chess.isInsufficientMaterial()) {
    return {
      status: GameStatus.INSUFFICIENT_MATERIAL,
      isOver: true,
      reason: "insufficient material",
    };
  }

  if (chess.isThreefoldRepetition()) {
    return {
      status: GameStatus.THREEFOLD_REPETITION,
      isOver: true,
      reason: "repetition",
    };
  }

  if (chess.isDraw()) {
    return {
      status: GameStatus.FIFTY_MOVE_RULE,
      isOver: true,
      reason: "50-move rule",
    };
  }

  return { status: GameStatus.DRAW, isOver: true, reason: "draw" };
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

  if (!raw || Object.keys(raw).length === 0) {
    throw new Error("Game not found or already ended.");
  }

  const state = parseGameState(raw, gameId);
  const isWhiteTurn = validateTurn(state, userId);

  const now = Date.now();
  const { whiteTime, blackTime, elapsed, isTimeout } = calculateClocks(
    state,
    now,
  );

  await cancelTimer(gameId);

  if (isTimeout) {
    const winnerId = isWhiteTurn ? state.blackId : state.whiteId;
    const status = GameStatus.TIME_OUT;

    await flushGameToDatabase(gameId, status, winnerId);

    const payload = {
      type: WsMessageType.GAME_OVER,
      payload: { status, winnerId, reason: "timeout" },
    };
    await Promise.all([
      sendToUser(state.whiteId, payload),
      sendToUser(state.blackId, payload),
    ]);
    return { isGameOver: true };
  }

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
  console.log(
    `[Move] ${userId.slice(0, 5)}: ${san} | Clocks W: ${Math.floor(whiteTime / 1000)}s, B: ${Math.floor(blackTime / 1000)}s`,
  );

  if (isOver) {
    await redis.hset(gameKey, {
      fen: chess.fen(),
      pgn: chess.pgn(),
      status,
      whiteTimeLeftMs: whiteTime,
      blackTimeLeftMs: blackTime,
      moveTimes: JSON.stringify(moveTimes),
    });

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

    const nextId = chess.turn() === "w" ? state.whiteId : state.blackId;
    const prevId = chess.turn() === "w" ? state.blackId : state.whiteId;
    const nextTime = chess.turn() === "w" ? whiteTime : blackTime;

    await startPlayerTimer(gameId, nextId, prevId, nextTime);
  }

  return {
    newFen: chess.fen(),
    pgn: chess.pgn(),
    move: san,
    isGameOver: isOver,
    moveTimes,
    whiteId: state.whiteId,
    blackId: state.blackId,
    whiteTimeLeftMs: whiteTime,
    blackTimeLeftMs: blackTime,
  };
}

export async function handleAbort(gameId: string, userId: string) {
  const gameKey = Keys.game(gameId);
  const raw = await redis.hgetall(gameKey);

  if (raw.whiteId !== userId && raw.blackId !== userId) return;

  const moveTimes = JSON.parse(raw.moveTimes || "[]");

  if (moveTimes.length > 2) {
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
  const drawKey = Keys.drawOffer(gameId);

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
    type: WsMessageType.OFFER_DRAW,
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
  const drawKey = Keys.drawOffer(gameId);
  const offeringUserId = await redis.get(drawKey);

  if (!offeringUserId || offeringUserId === userId) {
    throw new Error("No valid draw offer found to accept.");
  }
  const raw = await redis.hgetall(Keys.game(gameId));
  if (!raw.whiteId || !raw.blackId) return;

  const status = GameStatus.AGREEMENT;
  await flushGameToDatabase(gameId, status, undefined);

  const payload = {
    type: WsMessageType.GAME_OVER,
    payload: { status, reason: "agreement" },
  };

  await Promise.all([
    sendToUser(raw.whiteId, payload),
    sendToUser(raw.blackId, payload),
    redis.del(drawKey),
  ]);

  console.log(`[Game] Draw Accepted | Agreement by both players`);
}

export async function handleDrawDecline(gameId: string, userId: string) {
  const drawKey = Keys.drawOffer(gameId);
  const offeringUserId = await redis.get(drawKey);

  if (!offeringUserId || offeringUserId === userId) return;

  await redis.del(drawKey);

  await sendToUser(offeringUserId, {
    type: "DECLINE_DRAW",
    payload: { gameId, message: "Your opponent declined the draw offer." },
  });

  console.log(`[Game] Draw Declined | ID: ${gameId.slice(0, 8)}`);
}

export async function handleDrawExpire(gameId: string) {
  const drawKey = Keys.drawOffer(gameId);
  await redis.del(drawKey);
}

export async function handleResign(gameId: string, userId: string) {
  const activeGameId = await redis.get(Keys.userActiveGame(userId));
  if (activeGameId !== gameId) return;

  const gameKey = Keys.game(gameId);
  const gameState = await redis.hgetall(gameKey);
  if (!gameState || Object.keys(gameState).length === 0) return;

  await cancelTimer(gameId);
  const isWhite = gameState.whiteId === userId;
  const winnerId = isWhite ? gameState.blackId : gameState.whiteId;
  const status = GameStatus.RESIGN;

  console.log(
    `[Game] Resigned | ID: ${gameId.slice(0, 8)} | User: ${userId.slice(0, 5)}... resigned.`,
  );

  await flushGameToDatabase(gameId, status, winnerId);

  const resignPayload = {
    type: WsMessageType.GAME_OVER,
    payload: { status, winnerId, reason: "resignation" },
  };

  await Promise.all([
    sendToUser(gameState.whiteId, resignPayload),
    sendToUser(gameState.blackId, resignPayload),
  ]);
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
    const status = GameStatus.TIME_OUT;
    await flushGameToDatabase(gameId, status, winnerId);

    const payload = {
      type: WsMessageType.GAME_OVER,
      payload: { status, winnerId, reason: "timeout" },
    };
    await Promise.all([
      sendToUser(gameState.whiteId, payload),
      sendToUser(gameState.blackId, payload),
    ]);

    return null;
  }

  return {
    gameId,
    fen: gameState.fen,
    pgn: gameState.pgn,
    playerColor: gameState.whiteId === userId ? "w" : "b",
    turn: gameState.turn,
    status: gameState.status,
    whiteId: gameState.whiteId,
    blackId: gameState.blackId,
    whiteUser: gameState.whiteUser ? JSON.parse(gameState.whiteUser) : null,
    blackUser: gameState.blackUser ? JSON.parse(gameState.blackUser) : null,
    timeControl: gameState.timeControl,
    whiteTimeLeftMs: whiteTime,
    blackTimeLeftMs: blackTime,
  };
}

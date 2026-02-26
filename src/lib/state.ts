import { GameNotFoundError } from "./errors";

export interface GameState {
  whiteId: string;
  blackId: string;
  fen: string;
  pgn: string;
  status: string;
  turn: "w" | "b";
  timeControl: string;
  whiteTimeLeftMs: number;
  blackTimeLeftMs: number;
  lastMoveTimestamp: number;
}

export function parseGameState(
  raw: Record<string, string | undefined>,
  gameId: string,
): GameState {
  function require(field: string): string {
    const value = raw[field];
    if (!value) throw new GameNotFoundError(gameId);
    return value;
  }

  const whiteId = require("whiteId");
  const blackId = require("blackId");
  const fen = require("fen");
  const timeControl = require("timeControl");
  const rawTurn = require("turn");
  const rawWhiteTime = require("whiteTimeLeftMs");
  const rawBlackTime = require("blackTimeLeftMs");
  const rawLastMove = require("lastMoveTimestamp");

  const whiteTimeLeftMs = parseInt(rawWhiteTime, 10);
  const blackTimeLeftMs = parseInt(rawBlackTime, 10);
  const lastMoveTimestamp = parseInt(rawLastMove, 10);

  if (
    isNaN(whiteTimeLeftMs) ||
    isNaN(blackTimeLeftMs) ||
    isNaN(lastMoveTimestamp)
  ) {
    throw new GameNotFoundError(gameId);
  }

  return {
    whiteId,
    blackId,
    fen,
    pgn: raw.pgn ?? "",
    status: raw.status ?? "IN_PROGRESS",
    turn: rawTurn as "w" | "b",
    timeControl,
    whiteTimeLeftMs,
    blackTimeLeftMs,
    lastMoveTimestamp,
  };
}

export function getIncrementMs(timeControl: string): number {
  const inc = parseInt(timeControl.split("+")[1] ?? "0", 10);
  return isNaN(inc) ? 0 : inc * 1000;
}

import z from "zod";

export const WsMessageSchema = z.object({
  type: z.string(),
  payload: z.any(),
});

export const JoinQueueSchema = z.object({
  timeControl: z.enum(["1+0", "2+1", "3+2", "5+0", "10+0", "15+10"]),
});

export const MakeMoveSchema = z.object({
  gameId: z.string(),
  from: z.string().length(2),
  to: z.string().length(2),
  promotion: z.enum(["q", "r", "b", "n"]).optional(),
});

export const ResignGameSchema = z.object({
  gameId: z.string(),
});

export const AbortGameSchema = z.object({
  gameId: z.string(),
});

export const DrawActionSchema = z.object({
  gameId: z.string(),
});

export enum WsMessageType {
  JOIN_QUEUE = "JOIN_QUEUE",
  LEAVE_QUEUE = "LEAVE_QUEUE",
  QUEUE_JOINED = "QUEUE_JOINED",
  QUEUE_LEFT = "QUEUE_LEFT",

  MAKE_MOVE = "MAKE_MOVE",
  MOVE_MADE = "MOVE_MADE",
  MOVE_ACCEPTED = "MOVE_ACCEPTED",
  MOVE_REJECTED = "MOVE_REJECTED",
  MATCHMAKING_TIMEOUT = "MATCHMAKING_TIMEOUT",

  GAME_STARTED = "GAME_STARTED",
  GAME_ENDED = "GAME_ENDED",
  GAME_OVER = "GAME_OVER",

  OFFER_DRAW = "OFFER_DRAW",
  ACCEPT_DRAW = "ACCEPT_DRAW",
  DECLINE_DRAW = "DECLINE_DRAW",
  DRAW_OFFERED = "DRAW_OFFERED",
  DRAW_DECLINED = "DRAW_DECLINED",
  GAME_ABORTED = "GAME_ABORTED",
  RESIGN_GAME = "RESIGN_GAME",

  SYNC_GAME = "SYNC_GAME",
  GAME_STATE = "GAME_STATE",
  ERROR = "ERROR",
}

export enum GameStatus {
  IN_PROGRESS = "IN_PROGRESS",
  WHITE_WON = "WHITE_WON",
  BLACK_WON = "BLACK_WON",
  DRAW = "DRAW",
  TIME_OUT = "TIME_OUT",
  ABANDONED = "ABANDONED",
}

export { GameStatus as GameFinalStatus };

import {
  getSyncState,
  handleAbort,
  handleDrawAccept,
  handleDrawDecline,
  handleDrawOffer,
  processMove,
} from "../../core/game/engine";
import {
  handleJoinQueue,
  handleLeaveQueue,
} from "../../core/matchmaking/queue";
import {
  AbortGameSchema,
  DrawActionSchema,
  GameStatus,
  JoinQueueSchema,
  MakeMoveSchema,
  ResignGameSchema,
  WsMessageSchema,
  WsMessageType,
} from "../../types/events";

import type { AuthenticatedWebSocket } from "./web-socket-server";
import { sendToUser } from "./session-manager";
import { DomainError } from "../../lib/errors";
import { redis } from "../redis/redis-client";
import { Keys } from "../../lib/keys";
import { flushGameToDatabase } from "../../core/game/storage";

export async function routeMessage(
  ws: AuthenticatedWebSocket,
  rawMessage: string,
): Promise<void> {
  try {
    const parsedData = JSON.parse(rawMessage);
    const envelope = WsMessageSchema.parse(parsedData);

    switch (envelope.type) {
      case WsMessageType.JOIN_QUEUE: {
        const payload = JoinQueueSchema.parse(envelope.payload);

        ws.send(
          JSON.stringify({
            type: WsMessageType.QUEUE_JOINED,
            payload: { status: "waiting", timeControl: payload.timeControl },
          }),
        );

        handleJoinQueue(ws.userId, payload.timeControl).catch((err) => {
          console.error(`[Queue Error] for ${ws.userId}:`, err);
        });

        break;
      }
      case WsMessageType.MAKE_MOVE: {
        const payload = MakeMoveSchema.parse(envelope.payload);

        try {
          const result = await processMove(
            payload.gameId,
            ws.userId,
            payload.from,
            payload.to,
            payload.promotion,
          );

          const moveMadeMessage = {
            type: WsMessageType.MOVE_MADE,
            payload: {
              gameId: payload.gameId,
              fen: result.newFen,
              move: result.move,
              isGameOver: result.isGameOver,
            },
          };

          await Promise.all([
            sendToUser(result.whiteId, moveMadeMessage),
            sendToUser(result.blackId, moveMadeMessage),
          ]);
        } catch (err: unknown) {
          const isKnownError = err instanceof DomainError;
          console.error(
            `[Router] Move rejected — gameId: ${payload.gameId}, userId: ${ws.userId}`,
            isKnownError ? err.message : err,
          );

          const userMessage = isKnownError ? err.userMessage : "Move failed";
          await sendToUser(ws.userId, {
            type: WsMessageType.MOVE_REJECTED,
            payload: { reason: userMessage },
          });
        }
        break;
      }

      case WsMessageType.LEAVE_QUEUE:
        await handleLeaveQueue(ws.userId);
        ws.send(
          JSON.stringify({
            type: WsMessageType.QUEUE_LEFT,
            payload: { status: "idle" },
          }),
        );
        break;
      case WsMessageType.SYNC_GAME: {
        const state = await getSyncState(ws.userId);

        if (!state) {
          ws.send(
            JSON.stringify({
              type: WsMessageType.ERROR,
              payload: "No active game found to sync.",
            }),
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: WsMessageType.GAME_STATE,
            payload: state,
          }),
        );

        break;
      }
      case WsMessageType.OFFER_DRAW: {
        const { gameId } = DrawActionSchema.parse(envelope.payload);
        await handleDrawOffer(gameId, ws.userId);
        break;
      }

      case WsMessageType.ACCEPT_DRAW: {
        const { gameId } = DrawActionSchema.parse(envelope.payload);
        await handleDrawAccept(gameId, ws.userId);
        break;
      }

      case WsMessageType.DECLINE_DRAW: {
        const { gameId } = DrawActionSchema.parse(envelope.payload);
        await handleDrawDecline(gameId, ws.userId);
        break;
      }

      case WsMessageType.GAME_ABORTED: {
        const { gameId } = AbortGameSchema.parse(envelope.payload);
        await handleAbort(gameId, ws.userId);
        break;
      }

      case WsMessageType.RESIGN_GAME: {
        const result = ResignGameSchema.safeParse(envelope.payload);

        if (!result.success) {
          return ws.send(
            JSON.stringify({
              type: WsMessageType.ERROR,
              payload: "Invalid resignation payload",
            }),
          );
        }

        const { gameId } = result.data;
        const userId = ws.userId;

        // 2. Security Check: Is this user actually in this game?
        const activeGameId = await redis.get(Keys.userActiveGame(userId));
        if (activeGameId !== gameId) return;

        // 3. Fetch current state to identify winner/roles
        const gameKey = Keys.game(gameId);
        const gameState = await redis.hgetall(gameKey);
        if (!gameState || Object.keys(gameState).length === 0) return;

        const isWhite = gameState.whiteId === userId;
        const winnerId = isWhite ? gameState.blackId : gameState.whiteId;
        const status = isWhite ? GameStatus.BLACK_WON : GameStatus.WHITE_WON;

        console.log(
          `[Game] Resigned | ID: ${gameId.slice(0, 8)} | User: ${userId.slice(0, 5)}... resigned.`,
        );

        // 4. Persistence
        await flushGameToDatabase(gameId, status, winnerId);

        // 5. Global Notification
        const resignPayload = {
          type: WsMessageType.GAME_OVER,
          payload: { status, winnerId, reason: "resignation" },
        };

        await Promise.all([
          sendToUser(gameState.whiteId, resignPayload),
          sendToUser(gameState.blackId, resignPayload),
        ]);

        break;
      }

      default:
        console.warn(`[Router] Unknown message type: ${envelope.type}`);
        ws.send(
          JSON.stringify({
            type: WsMessageType.ERROR,
            payload: "Unknown message type",
          }),
        );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Router] Message handling failed:", message);
    ws.send(
      JSON.stringify({
        type: WsMessageType.ERROR,
        payload: "Invalid message format",
      }),
    );
  }
}

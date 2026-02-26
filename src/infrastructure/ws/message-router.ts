import {
  getSyncState,
  handleAbort,
  handleDrawAccept,
  handleDrawDecline,
  handleDrawOffer,
  handleResign,
  processMove,
} from "../../core/game/engine";
import {
  handleJoinQueue,
  handleLeaveQueue,
} from "../../core/matchmaking/queue";
import {
  GameIdOnlySchema,
  JoinQueueSchema,
  MakeMoveSchema,
  ResignGameSchema,
  WsMessageSchema,
} from "../../types/events";

import type { AuthenticatedWebSocket } from "./web-socket-server";
import { sendToUser } from "./session-manager";
import { DomainError } from "../../lib/errors";
import { WsMessageType } from "../../types/types";

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

          if (
            !result.whiteId ||
            !result.blackId ||
            !result.newFen ||
            !result.move
          ) {
            return;
          }

          const moveMadeMessage = {
            type: WsMessageType.MOVE_MADE,
            payload: {
              gameId: payload.gameId,
              fen: result.newFen,
              move: result.move,
              whiteTimeMs: result.whiteTimeLeftMs,
              blackTimeMs: result.blackTimeLeftMs,
              isGameOver: result.isGameOver,
            },
          };

          await Promise.all([
            sendToUser(result.whiteId, moveMadeMessage),
            sendToUser(result.blackId, moveMadeMessage),
          ]);
        } catch (err: unknown) {
          const isKnownError = err instanceof DomainError;

          const userMessage = isKnownError ? err.userMessage : isKnownError;
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
        const { gameId } = GameIdOnlySchema.parse(envelope.payload);
        await handleDrawOffer(gameId, ws.userId);
        break;
      }

      case WsMessageType.ACCEPT_DRAW: {
        const { gameId } = GameIdOnlySchema.parse(envelope.payload);
        await handleDrawAccept(gameId, ws.userId);
        break;
      }

      case WsMessageType.DECLINE_DRAW: {
        const { gameId } = GameIdOnlySchema.parse(envelope.payload);
        await handleDrawDecline(gameId, ws.userId);
        break;
      }

      case WsMessageType.GAME_ABORTED: {
        const { gameId } = GameIdOnlySchema.parse(envelope.payload);
        await handleAbort(gameId, ws.userId);
        break;
      }

      case WsMessageType.RESIGN_GAME: {
        const { gameId } = ResignGameSchema.parse(envelope.payload);
        await handleResign(gameId, ws.userId);
        break;
      }

      default:
        console.warn(`[Router] Unknown message type:`, envelope);
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

import type { Server, IncomingMessage } from "http";
import WebSocket, { WebSocketServer } from "ws";

import { routeMessage } from "./message-router";
import { registerSession, unregisterSession } from "./session-manager";
import {
  startReconnectTimer,
  cancelReconnectTimer,
} from "../../core/game/timer";
import { redis } from "../redis/redis-client";
import { Keys } from "../../lib/keys";
import { AuthError } from "../../lib/errors";
import { auth } from "../../lib/auth";
import { getSyncState } from "../../core/game/engine";
import { WsMessageType } from "../../types/types";
import { handleLeaveQueue } from "../../core/matchmaking/queue";

export interface AuthenticatedWebSocket extends WebSocket {
  userId: string;
  isAlive: boolean;
}

async function extractUserId(req: IncomingMessage): Promise<string> {
  try {
    const session = await auth.api.getSession({
      headers: req.headers as Record<string, string>,
    });

    if (!session || !session.user) {
      throw new AuthError("Invalid or expired session");
    }
    return session.user.id;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error("[WS Auth Error]", err);
    throw new AuthError("Authentication failed");
  }
}

export function initializeWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ server });

  // --- HEARTBEAT LOGIC ---
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as AuthenticatedWebSocket;
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeatInterval));

  // --- CONNECTION LOGIC ---
  wss.on("connection", async (ws: AuthenticatedWebSocket, req) => {
    ws.isAlive = true;
    let userId: string;

    try {
      userId = await extractUserId(req);
    } catch (err: unknown) {
      const msg = err instanceof AuthError ? err.userMessage : "Unauthorized";
      ws.send(JSON.stringify({ type: "ERROR", payload: msg }));
      ws.close(1008, "Unauthorized");
      return;
    }

    ws.userId = userId;

    // 1. Session & Reconnection Management
    await registerSession(userId, ws);

    const activeGameId = await redis.get(Keys.userActiveGame(userId));
    if (activeGameId) {
      // Stop the "Abandonment" clock because the user is back
      await cancelReconnectTimer(activeGameId, userId);
    }

    // 2. State Rehydration (Sync)
    // Automatically send the current board state if they are in a game
    try {
      const initialState = await getSyncState(userId);
      if (initialState) {
        ws.send(
          JSON.stringify({
            type: WsMessageType.GAME_STATE,
            payload: initialState,
          }),
        );
      }
    } catch (err) {
      console.error(`[Sync Error] Failed to fetch state for ${userId}:`, err);
    }

    // --- EVENT HANDLERS ---
    ws.on("message", (message: Buffer) => {
      routeMessage(ws, message.toString());
    });

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("close", async () => {
      // A. Unregister from active sessions
      await unregisterSession(userId);

      // B. Cleanup Matchmaking (Don't let ghosts stay in queue)
      await handleLeaveQueue(userId).catch(console.error);

      // C. Handle Reconnection Window
      // If they were in a game, start a timer. If they don't return, they lose.
      const gameId = await redis.get(Keys.userActiveGame(userId));
      if (gameId) {
        await startReconnectTimer(gameId, userId);
      }
    });

    ws.on("error", (err) => {
      console.error(`[WS Error] User ${userId}:`, err);
    });
  });
}

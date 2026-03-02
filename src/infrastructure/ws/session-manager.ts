import { v7 as uuidv7 } from "uuid";
import { redis } from "../../infrastructure/redis/redis-client";
import { Keys } from "../../lib/keys";
import type { AuthenticatedWebSocket } from "./web-socket-server";

const localSessions = new Map<string, AuthenticatedWebSocket>();

export const INSTANCE_ID = uuidv7();

const subscriber = redis.duplicate();

subscriber.subscribe(`ws:instance:${INSTANCE_ID}`, (err) => {
  if (err) {
    console.error("[Sessions] Failed to subscribe to instance channel:", err);
  } else {
    console.log(
      `[Sessions] Listening on pub/sub channel ws:instance:${INSTANCE_ID}`,
    );
  }
});

subscriber.on("message", (_channel: string, raw: string) => {
  try {
    const { userId, payload } = JSON.parse(raw) as {
      userId: string;
      payload: string;
    };

    const ws = localSessions.get(userId);
    if (ws?.readyState === 1) {
      ws.send(payload);
    }
  } catch (err) {
    console.error("[Sessions] Failed to process pub/sub message:", err);
  }
});

export async function registerSession(
  userId: string,
  ws: AuthenticatedWebSocket,
): Promise<void> {
  localSessions.set(userId, ws);

  await redis.set(Keys.session(userId), INSTANCE_ID, "EX", 86_400);
}

export async function unregisterSession(userId: string): Promise<void> {
  localSessions.delete(userId);
  await redis.del(Keys.session(userId));
}

export async function sendToUser(
  userId: string,
  message: unknown,
): Promise<void> {
  const payload = JSON.stringify(message);

  const ws = localSessions.get(userId);
  if (ws?.readyState === 1) {
    ws.send(payload);
    return;
  }

  const instanceId = await redis.get(Keys.session(userId));
  if (instanceId) {
    await redis.publish(
      `ws:instance:${instanceId}`,
      JSON.stringify({ userId, payload }),
    );
  } else {
    console.warn(`[Sessions] User ${userId} is offline — message dropped`);
  }
}

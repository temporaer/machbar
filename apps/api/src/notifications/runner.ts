import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { VapidConfig } from "../env.js";
import {
  createWebPushTransport,
  dispatchNotificationEvents,
  type PushTransport,
} from "./delivery.js";
import { enqueueDueReminders } from "./outbox.js";

const POLL_INTERVAL_MS = 15_000;

export function registerNotificationRunner(
  app: FastifyInstance,
  db: Db,
  config: VapidConfig | null,
  suppliedTransport?: PushTransport,
): void {
  const transport =
    suppliedTransport ??
    (config
      ? createWebPushTransport(config)
      : { send: async () => undefined });
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const runOnce = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        enqueueDueReminders(db);
        await dispatchNotificationEvents(db, transport, {
          error: (message, context) => app.log.error(context ?? {}, message),
        });
      } catch (error) {
        app.log.error(error, "Notification dispatcher pass failed.");
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  app.addHook("onReady", async () => {
    void runOnce();
    timer = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  });
  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    await inFlight;
  });
}

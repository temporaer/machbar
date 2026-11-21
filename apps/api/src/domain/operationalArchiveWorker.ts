import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { archiveTerminalWorkBatch } from "../repo/operationalArchiveRepo.js";

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 60_000;

/** Runs one bounded archival batch at startup and periodically thereafter.
 * A delayed or failed pass only leaves extra terminal rows in operational
 * reads; it cannot hide newly active work because mutations restore the path
 * synchronously and the repository rechecks eligibility in its UPDATE. */
export function registerOperationalArchiveWorker(
  app: FastifyInstance,
  db: Db,
): void {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  const runOnce = () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => {
      const archived = archiveTerminalWorkBatch(db, { limit: BATCH_SIZE });
      if (archived > 0) app.log.info({ archived }, "Archived terminal work batch.");
    }).catch((error: unknown) => {
      app.log.error(error, "Operational archive pass failed.");
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  app.addHook("onReady", async () => {
    void runOnce();
    timer = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await inFlight;
  });
}

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { purgeExpiredIntakes } from "./jobs.js";
import { purgeExpiredCleanupRounds } from "../cleanupRound/jobs.js";

export function registerIntakeCleanup(app: FastifyInstance, db: Db, env: Env): void {
  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    const purge = async () => {
      purgeExpiredCleanupRounds(db);
      await purgeExpiredIntakes(db, env);
    };
    await purge();
    timer = setInterval(() => void purge(), 10 * 60 * 1000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}

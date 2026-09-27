import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { purgeExpiredIntakes } from "./jobs.js";

export function registerIntakeCleanup(app: FastifyInstance, db: Db, env: Env): void {
  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    await purgeExpiredIntakes(db, env);
    timer = setInterval(() => void purgeExpiredIntakes(db, env), 10 * 60 * 1000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}

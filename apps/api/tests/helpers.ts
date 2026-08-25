import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import type { Env } from "../src/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestContext {
  app: FastifyInstance;
  handle: DbHandle;
}

/** Builds a fresh in-memory database + Fastify app for a single test file. */
export function createTestContext(options?: { seed?: boolean }): TestContext {
  const handle = openDb(":memory:");
  runMigrations(handle.db);
  if (options?.seed) {
    seedDatabase(handle.db);
  }
  const env: Env = {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(__dirname, "__fixtures__"),
    databaseFile: "unused.db",
    databasePath: ":memory:",
    basePath: "/",
    seedDatabase: false,
    webDistDir: path.join(__dirname, "__no_web_dist__"),
  };
  const app = buildApp({ db: handle.db, env, logger: false });
  return { app, handle };
}

export async function closeTestContext(ctx: TestContext) {
  await ctx.app.close();
  ctx.handle.close();
}

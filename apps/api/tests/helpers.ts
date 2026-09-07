import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import type { Env } from "../src/env.js";
import type { OidcConfig } from "../src/env.js";
import type { OidcProvider } from "../src/auth/oidcClient.js";
import type { ChangeNotifier } from "../src/changeNotifier.js";
import type { VapidConfig } from "../src/env.js";
import type { PushTransport } from "../src/notifications/delivery.js";
import type { PaperlessConfig } from "../src/env.js";
import type { PaperlessClient } from "../src/paperless/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestContext {
  app: FastifyInstance;
  handle: DbHandle;
}

/** Builds a fresh in-memory database + Fastify app for a single test file. */
export function createTestContext(options?: {
  seed?: boolean;
  oidc?: OidcConfig;
  oidcProvider?: OidcProvider;
  basePath?: string;
  changeNotifier?: ChangeNotifier;
  push?: VapidConfig;
  pushTransport?: PushTransport;
  paperless?: PaperlessConfig;
  paperlessClient?: PaperlessClient;
}): TestContext {
  const handle = openDb(":memory:");
  runMigrations(handle.db);
  // Test-only convenience: many tests build fixtures with raw
  // `.insert(schema.tasks)`/`.insert(schema.projects)` calls that don't
  // specify `id`, bypassing `allocateWorkItemId()` (the only path real
  // application code uses to populate the shared `work_items` identity
  // table introduced by the 0023 migration). Auto-create the matching
  // work_items row so those FK-backed inserts still succeed; production
  // code must keep going through `allocateWorkItemId()` explicitly.
  handle.sqlite.exec(`
    CREATE TRIGGER test_only_projects_work_item_autofill
    AFTER INSERT ON projects
    WHEN NEW.id NOT IN (SELECT id FROM work_items)
    BEGIN
      INSERT INTO work_items (id) VALUES (NEW.id);
    END;
    CREATE TRIGGER test_only_tasks_work_item_autofill
    AFTER INSERT ON tasks
    WHEN NEW.id NOT IN (SELECT id FROM work_items)
    BEGIN
      INSERT INTO work_items (id) VALUES (NEW.id);
    END;
  `);
  if (options?.seed) {
    seedDatabase(handle.db);
  }
  const env: Env = {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(__dirname, "__fixtures__"),
    databaseFile: "unused.db",
    databasePath: ":memory:",
    basePath: options?.basePath ?? "/",
    seedDatabase: false,
    webDistDir: path.join(__dirname, "__no_web_dist__"),
    oidc: options?.oidc ?? null,
    push: options?.push ?? null,
    paperless: options?.paperless ?? null,
  };
  const app = buildApp({
    db: handle.db,
    env,
    logger: false,
    oidcProvider: options?.oidcProvider,
    changeNotifier: options?.changeNotifier,
    pushTransport: options?.pushTransport,
    paperlessClient: options?.paperlessClient,
  });
  return { app, handle };
}

export async function closeTestContext(ctx: TestContext) {
  await ctx.app.close();
  ctx.handle.close();
}

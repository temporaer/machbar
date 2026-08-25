import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadEnv } from "../env.js";
import { openDb, type Db } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Applies all pending SQL migrations to the given drizzle instance.
 *
 * drizzle's `migrate()` runs every pending migration inside a single
 * implicit transaction, in which `PRAGMA foreign_keys` toggles are no-ops
 * (SQLite only honours that pragma outside of an active transaction). Any
 * migration that rebuilds a table referenced by other tables' foreign keys
 * (e.g. dropping `projects.description` requires SQLite's 12-step rebuild)
 * would otherwise have its `DROP TABLE` step cascade-delete or null out
 * dependent rows, because foreign key enforcement stays ON throughout. We
 * therefore disable enforcement before the transaction starts and restore
 * it afterwards, matching `openDb`'s normal "foreign_keys = ON" default.
 */
export function runMigrations(db: Db): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

async function main() {
  const env = loadEnv();
  const { db, close } = openDb(env.databasePath);
  runMigrations(db);
  console.log(`Migrations applied to ${env.databasePath}`);
  close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

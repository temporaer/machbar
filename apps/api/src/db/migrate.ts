import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadEnv } from "../env.js";
import { openDb, type Db } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/** Applies all pending SQL migrations to the given drizzle instance. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
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

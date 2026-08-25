import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Opens a better-sqlite3 connection at the given path (or in-memory when
 * `:memory:` is passed) and wraps it in a drizzle instance. Foreign keys are
 * enabled explicitly since better-sqlite3 does not turn them on by default.
 */
export function openDb(databasePath: string): DbHandle {
  if (databasePath !== ":memory:") {
    const dir = path.dirname(databasePath);
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(databasePath);
  if (databasePath !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

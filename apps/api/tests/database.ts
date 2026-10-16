import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { inject } from "vitest";
import type { Db, DbHandle } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseTemplatePath: string;
  }
}

/** Each caller owns a mutable in-memory copy; only the migrated bytes are shared. */
export function createTestDatabase(): DbHandle {
  const sqlite = new Database(fs.readFileSync(inject("databaseTemplatePath")));
  sqlite.pragma("foreign_keys = ON");
  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

export function insertTestProject(
  db: Db,
  values: Partial<typeof schema.workItems.$inferInsert> & {
    title: string;
    status?: "backlog" | "active" | "completed" | "archived";
  },
) {
  const { status = "backlog", ...rest } = values;
  return db
    .insert(schema.workItems)
    .values({
      ...rest,
      role: "story",
      status:
        status === "completed"
          ? "done"
          : status === "archived"
            ? "backlog"
            : status,
      archivedAt: status === "archived" ? new Date().toISOString() : null,
    })
    .returning()
    .get();
}

export function insertTestTask(
  db: Db,
  values: Omit<Partial<typeof schema.workItems.$inferInsert>, "status"> & {
    title: string;
    status?: "captured" | "actionable" | "someday" | "done" | "cancelled";
    projectId?: number | null;
    parentTaskId?: number | null;
  },
) {
  const {
    status = "actionable",
    projectId = null,
    parentTaskId = null,
    ...rest
  } = values;
  const row = db
    .insert(schema.workItems)
    .values({
      ...rest,
      role: "task",
      parentId: parentTaskId ?? projectId,
      status:
        status === "actionable"
          ? "active"
          : status === "someday"
            ? "backlog"
            : status,
      needsClarification: status === "captured",
    })
    .returning()
    .get();
  return { ...row, status, projectId, parentTaskId };
}

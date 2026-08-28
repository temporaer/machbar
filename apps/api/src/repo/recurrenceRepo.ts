import type { TaskRecurrenceHistory } from "@machbar/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

export function getTaskRecurrenceHistory(
  db: Db,
  taskId: number,
): TaskRecurrenceHistory {
  const occurrences = db
    .select()
    .from(schema.taskRecurrenceOccurrences)
    .where(eq(schema.taskRecurrenceOccurrences.taskId, taskId))
    .orderBy(
      desc(schema.taskRecurrenceOccurrences.completedAt),
      desc(schema.taskRecurrenceOccurrences.id),
    )
    .all();
  const hitCount = occurrences.filter((row) => row.result === "hit").length;
  const missCount = occurrences.length - hitCount;
  return {
    summary: {
      hitCount,
      missCount,
      totalCount: occurrences.length,
      hitRate:
        occurrences.length === 0 ? null : hitCount / occurrences.length,
    },
    occurrences,
  };
}

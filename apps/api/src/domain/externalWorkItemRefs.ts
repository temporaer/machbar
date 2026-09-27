import { and, eq } from "drizzle-orm";
import type { ExternalWorkItemRef } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

export function addExternalWorkItemRef(
  db: Db,
  workItemId: number,
  ref: ExternalWorkItemRef & { correlationId?: string },
): void {
  db.insert(schema.externalWorkItemRefs).values({
    workItemId,
    source: ref.source,
    externalId: `${ref.calendarEntityId}:${ref.uid}`,
    metadataJson: JSON.stringify(ref),
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing().run();
}

export function listExternalWorkItemRefs(
  db: Db,
  workItemId: number,
): ExternalWorkItemRef[] {
  return db.select().from(schema.externalWorkItemRefs)
    .where(and(
      eq(schema.externalWorkItemRefs.workItemId, workItemId),
      eq(schema.externalWorkItemRefs.source, "home_assistant_calendar"),
    )).all()
    .map((row) => JSON.parse(row.metadataJson) as ExternalWorkItemRef);
}

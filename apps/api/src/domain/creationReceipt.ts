import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { creationReceipts } from "../db/schema.js";
import { AppError } from "../errors.js";
import { assertWorkItemAccessible } from "./workItemShared.js";

/** A receipt and its canonical creation commit in the same transaction. Replays
 * authorize the current item; deleted or newly hidden work is never recreated. */
export function createWithReceipt(
  db: Db,
  input: { key: string | string[] | undefined; route: string; viewer: number | undefined; body: unknown },
  create: () => { id: number },
): { id: number; replayed: boolean } {
  if (input.key === undefined) return db.transaction(() => {
    const created = create();
    assertWorkItemAccessible(db, created.id, input.viewer);
    return { id: created.id, replayed: false };
  });
  if (typeof input.key !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.key)) {
    throw AppError.badRequest("malformed_request", "Invalid creation request key");
  }
  const requestKey = input.key;
  const viewerKey = input.viewer === undefined ? "anonymous" : `member:${input.viewer}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(input.body)).digest("hex");
  return db.transaction(() => {
    const prior = db.select().from(creationReceipts).where(and(
      eq(creationReceipts.requestKey, requestKey), eq(creationReceipts.route, input.route), eq(creationReceipts.viewerKey, viewerKey),
    )).get();
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw AppError.conflict("stale_write_conflict", "Creation request key was reused with different content", { reason: "creation_request_mismatch" });
      if (prior.workItemId === null) throw AppError.notFound("task_not_found", "The original creation was deleted");
      assertWorkItemAccessible(db, prior.workItemId, input.viewer);
      return { id: prior.workItemId, replayed: true };
    }
    const created = create();
    assertWorkItemAccessible(db, created.id, input.viewer);
    db.insert(creationReceipts).values({ requestKey, route: input.route, viewerKey, fingerprint, workItemId: created.id }).run();
    return { id: created.id, replayed: false };
  });
}

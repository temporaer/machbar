import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import { ChangeNotifier } from "../src/changeNotifier.js";
import { createProject } from "../src/domain/storyCrud.js";
import * as schema from "../src/db/schema.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const cases = [true, false].flatMap(ancestorVisible => ["read", "stale-deadline", "fresh-deadline"].map(operation => ({ ancestorVisible, operation })));

describe("project activation snapshot visibility at every public exit", () => {
  let ctx: TestContext;
  afterEach(async () => closeTestContext(ctx));
  it.each(cases)("$operation with ancestor visible: $ancestorVisible", async ({ ancestorVisible, operation }) => {
    const notifier = new ChangeNotifier();
    const notified = vi.fn(); notifier.subscribe(notified);
    ctx = createTestContext({ changeNotifier: notifier });
    const member = (name: string) => ctx.handle.db.insert(schema.members).values({ name, color: "#111111" }).returning().get();
    const viewer = member("Viewer"), other = member("Other");
    const ancestor = createProject(ctx.handle.db, { title: "Ancestor-only confidential title", scope: "work", ownerMemberId: ancestorVisible ? viewer.id : other.id });
    const source = createProject(ctx.handle.db, { title: "Viewer-owned child", parentId: ancestor.id, ownerMemberId: viewer.id });
    const before = createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex");
    notified.mockClear();
    const headers = { [ACTIVITY_ACTOR_HEADER]: String(viewer.id) };
    const response = await ctx.app.inject(operation === "read"
      ? { method: "GET", url: `/api/projects/${source.id}`, headers }
      : { method: "PATCH", url: `/api/projects/${source.id}`, headers, payload: { dueDate: "2027-01-15", expectedRevision: source.revision + (operation === "stale-deadline" ? 5 : 0) } });
    expect(response.statusCode, response.body).toBe(operation === "read" ? 200 : ancestorVisible ? 409 : 404);
    if (!ancestorVisible) expect(response.body).not.toContain(ancestor.title);
    if (operation === "read") {
      if (ancestorVisible) expect(response.json().activationDecisionSnapshot.expectedProjects).toEqual(expect.arrayContaining([{ projectId: ancestor.id, revision: ancestor.revision }]));
      else expect(response.json()).not.toHaveProperty("activationDecisionSnapshot");
      expect(response.json().directActivationDecisionSnapshot.expectedProjects).toEqual([{ projectId: source.id, revision: source.revision }]);
    } else if (ancestorVisible) {
      expect(response.json().error.code).toBe("project_commitment_resolution_required");
      expect(response.json().error.details.expectedProjects).toEqual(expect.arrayContaining([{ projectId: ancestor.id, revision: ancestor.revision }]));
    }
    expect(createHash("sha256").update(ctx.handle.sqlite.serialize()).digest("hex")).toBe(before);
    expect(notified).not.toHaveBeenCalled();
  });
});

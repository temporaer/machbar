import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, closeTestContext, type TestContext } from "./helpers.js";
import * as schema from "../src/db/schema.js";
import { createGoal, startIntervention, backIntervention, getGoal, concludeIntervention } from "../src/domain/goals.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(async () => { await closeTestContext(ctx); });
function setup(type: "exploration_step" | "frequency_habit" = "frequency_habit") {
  const member = ctx.handle.db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
  const goal = createGoal(ctx.handle.db, { title: "Piano", ownerMemberId: member.id }, "2026-10-15");
  return { member, goal, intervention: startIntervention(ctx.handle.db, goal.id, { type, commitment: "Practise piano", startDate: "2026-10-15", revisitDate: "2026-10-29" }, "2026-10-15") };
}
it("creates separate supported Tuesday/Thursday tasks at 19:00 and reuses them on lost-response retry", () => {
  const { intervention: i, member } = setup(); const db = ctx.handle.db;
  const tasks = [
    { key: "tuesday", title: "Tuesday practice", scheduledDate: "2026-10-20", reminders: [{ kind: "absolute" as const, at: "2026-10-20T17:00:00Z" }] },
    { key: "thursday", title: "Thursday practice", scheduledDate: "2026-10-22", reminders: [{ kind: "absolute" as const, at: "2026-10-22T17:00:00Z" }] },
  ];
  const first = backIntervention(db, i.id, { tasks, expectedRevision: i.revision }, "2026-10-15");
  expect(first.generatedTasks).toHaveLength(2);
  expect(backIntervention(db, i.id, { tasks, expectedRevision: i.revision }, "2026-10-15").generatedTasks).toEqual(first.generatedTasks);
  for (const generated of first.generatedTasks!) {
    const task = db.select().from(schema.workItems).where(eq(schema.workItems.id, generated.taskId!)).get()!;
    expect(task).toMatchObject({ privacyOwnerMemberId: member.id, scope: "household", status: "active" });
    expect(db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).all()).toHaveLength(1);
  }
});
it("creates exploration work and recurring practice atomically; rejects invalid batches without leftovers", () => {
  const { intervention: i } = setup("exploration_step"); const db = ctx.handle.db;
  expect(() => backIntervention(db, i.id, { tasks: [{ key: "valid", title: "Book trial lesson" }, { key: "invalid", title: "" }] }, "2026-10-15")).toThrow();
  expect(db.select().from(schema.workItems).all()).toHaveLength(0);
  const backed = backIntervention(db, i.id, { tasks: [{ key: "trial", title: "Book trial lesson" }, { key: "practice", title: "Practise", scheduledDate: "2026-10-20", repeatAfterDays: 7, allowedDeviationDays: 0 }] }, "2026-10-15");
  expect(backed.generatedTasks).toHaveLength(2);
  const recurring = db.select().from(schema.workItems).where(eq(schema.workItems.id, backed.generatedTasks!.find((t) => t.key === "practice")!.taskId!)).get()!;
  expect(recurring.repeatAfterDays).toBe(7);
});
it("retains provenance after deletion, and keep/stop handles all generated tasks without fabricating success", () => {
  const { intervention: i, goal } = setup(); const db = ctx.handle.db;
  const backed = backIntervention(db, i.id, { tasks: [{ key: "a", title: "A" }, { key: "b", title: "B" }] }, "2026-10-15");
  const ids = backed.generatedTasks!.map((t) => t.taskId!);
  db.delete(schema.workItems).where(eq(schema.workItems.id, ids[0]!)).run();
  const updated = getGoal(db, goal.id, "2026-10-15").interventions[0]!;
  expect(updated.generatedTasks![0]).toMatchObject({ taskId: null, originalTaskId: ids[0], title: "A" });
  concludeIntervention(db, i.id, updated.revision, "2026-10-15", { backingCleanup: "stop" });
  expect(db.select().from(schema.workItems).where(eq(schema.workItems.id, ids[1]!)).get()!.status).toBe("cancelled");
  expect(db.select().from(schema.interventionTasks).all()).toHaveLength(2);
});

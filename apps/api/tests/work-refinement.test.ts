import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTask, getTaskOrThrow } from "../src/domain/taskCrud.js";
import * as schema from "../src/db/schema.js";
import { onIntakeAnalyzed, getIntake } from "../src/intake/jobs.js";
import { applyWorkRefinement, updateWorkRefinement } from "../src/intake/refinement.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("AI work refinement proposals", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => closeTestContext(ctx));

  it("stores unaccepted recommendations and applies selected updates and children atomically", () => {
    const task = createTask(ctx.handle.db, { title: "Backup-Konzept verbessern", notes: "PBS läuft", status: "actionable" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, children: [] });
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "next_action", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).get()!, {
      intent: "next_action", summary: "Ein Wiederherstellungstest klärt die wichtigste offene Unsicherheit.", disposition: "changes", question: null,
      changes: [
        { kind: "create_child", parentTaskId: task.id, title: "Eine Datei aus dem PBS-Backup testweise wiederherstellen", notes: null, rationale: "Prüft, ob die laufenden Sicherungen tatsächlich wiederherstellbar sind.", accepted: true },
        { kind: "create_child", parentTaskId: task.id, title: "Duplizierter Restore-Test", notes: null, rationale: "Nicht übernehmen.", accepted: false },
      ],
    });
    const ready = getIntake(ctx.handle.db, id, null);
    expect(ready.refinement?.proposal?.changes[0]?.accepted).toBe(false);
    const proposal = ready.refinement!.proposal!;
    proposal.changes[0]!.accepted = true;
    updateWorkRefinement(ctx.handle.db, id, null, ready.revision, proposal);
    applyWorkRefinement(ctx.handle.db, id, null, ready.revision + 1, {});
    const updated = getTaskOrThrow(ctx.handle.db, task.id);
    expect(updated.id).toBe(task.id);
    expect(updated.notes).toBe("PBS läuft");
    expect(updated.children.map((child) => child.title)).toEqual(["Eine Datei aus dem PBS-Backup testweise wiederherstellen"]);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("rejects stale proposals without changing the task", () => {
    const task = createTask(ctx.handle.db, { title: "Kita-Formular", status: "actionable" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, children: [] });
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify({ intent: "improve", summary: "Klarer benennen", disposition: "changes", question: null, changes: [{ kind: "update_task", targetId: task.id, title: "Kita-Formular im Sekretariat abgeben", rationale: "Macht die nächste Handlung erkennbar.", accepted: true }] }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    const current = getTaskOrThrow(ctx.handle.db, task.id);
    ctx.handle.db.update(schema.workItems).set({ title: "Changed concurrently", revision: current.revision + 1 }).where(eq(schema.workItems.id, task.id)).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/changed/i);
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Changed concurrently");
  });

  it("accepts a leave-alone result without manufacturing a mutation", () => {
    const task = createTask(ctx.handle.db, { title: "Send the signed form", status: "actionable" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, status: "actionable", kind: "action", children: [] });
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, { intent: "improve", summary: "Die Aufgabe ist klar und ausführbar.", disposition: "leave_alone", question: null, changes: [] });
    const ready = getIntake(ctx.handle.db, id, null);
    expect(ready.refinement?.proposal?.disposition).toBe("leave_alone");
    applyWorkRefinement(ctx.handle.db, id, null, ready.revision, {});
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Send the signed form");
  });

  it("requires and applies an explicit legal conversion before refining a captured task", () => {
    const task = createTask(ctx.handle.db, { title: "Neue Haustür", status: "captured" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, status: "captured", kind: "action", parentTaskId: null, projectId: null, externalWait: null, dependencies: [], repeatAfterDays: null, reminders: [], children: [] });
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, {
      intent: "structure", summary: "Mache das Vorhaben zu einem Projekt.", disposition: "changes", question: null,
      changes: [
        { kind: "convert_task_to_project", targetId: task.id, rationale: "Das Vorhaben umfasst mehrere Schritte." },
        { kind: "create_child", parentTaskId: task.id, title: "Klären, ob noch die Auswahl oder nur die Montage ansteht", notes: null, rationale: "Die Entscheidung bestimmt den nächsten Arbeitsweg." },
      ],
    });
    const ready = getIntake(ctx.handle.db, id, null);
    expect(ready.status).toBe("ready");
    const proposal = ready.refinement!.proposal!;
    proposal.changes = proposal.changes.map((change) => ({ ...change, accepted: true }));
    updateWorkRefinement(ctx.handle.db, id, null, ready.revision, proposal);
    applyWorkRefinement(ctx.handle.db, id, null, ready.revision + 1, {});
    const converted = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!;
    expect(converted.role).toBe("story");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all().map((row) => row.title)).toEqual(["Klären, ob noch die Auswahl oder nur die Montage ansteht"]);
  });

  it("rolls back every accepted mutation when a later operation is invalid", () => {
    const task = createTask(ctx.handle.db, { title: "Kita-Formular", status: "actionable" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, children: [] });
    const proposal = { intent: "improve", summary: "Klarer machen", disposition: "changes", question: null, changes: [
      { kind: "update_task", targetId: task.id, title: "Kita-Formular im Sekretariat abgeben", rationale: "Macht den nächsten Schritt sichtbar.", accepted: true },
      { kind: "add_dependency", taskId: task.id, dependsOnTaskId: task.id, rationale: "Ungültiger Selbstbezug.", accepted: true },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow();
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Kita-Formular");
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createChildTask, createTask, getTaskOrThrow } from "../src/domain/taskCrud.js";
import { createProject } from "../src/domain/storyCrud.js";
import { addDependency } from "../src/domain/taskCapabilities.js";
import * as schema from "../src/db/schema.js";
import { onIntakeAnalyzed, getIntake } from "../src/intake/jobs.js";
import { applyWorkRefinement, updateWorkRefinement } from "../src/intake/refinement.js";
import { buildRefinementSnapshot } from "../src/intake/refinementSnapshot.js";
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
        { kind: "create_child", parentTaskId: task.id, title: "Klären, ob noch die Auswahl oder nur die Montage ansteht", notes: null, rationale: "Die Entscheidung bestimmt den nächsten Arbeitsweg." },
        { kind: "convert_task_to_project", targetId: task.id, rationale: "Das Vorhaben umfasst mehrere Schritte." },
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

  it("rejects a selected captured-task child when its conversion is excluded", () => {
    const task = createTask(ctx.handle.db, { title: "Neue Haustür", status: "captured" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, status: "captured", kind: "action", parentTaskId: null, projectId: null, externalWait: null, dependencies: [], repeatAfterDays: null, reminders: [], children: [] });
    const proposal = { intent: "structure", summary: "Ein Schritt braucht eine Projektstruktur.", disposition: "changes", question: null, changes: [
      { kind: "create_child", parentTaskId: task.id, title: "Montage klären", rationale: "Ein nächster Schritt.", accepted: true },
      { kind: "convert_task_to_project", targetId: task.id, rationale: "Ermöglicht Unteraufgaben.", accepted: false },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/requires accepting/i);
    expect(getTaskOrThrow(ctx.handle.db, task.id).status).toBe("captured");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children).toHaveLength(0);
  });

  it("rejects dependencies that introduce a cycle before applying any change", () => {
    const parent = createTask(ctx.handle.db, { title: "Plan", status: "actionable" });
    const first = createChildTask(ctx.handle.db, parent.id, { title: "First", status: "actionable" });
    const second = createChildTask(ctx.handle.db, parent.id, { title: "Second", status: "actionable" });
    addDependency(ctx.handle.db, second.id, first.id);
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", parent.id, null).snapshot;
    const id = randomUUID();
    const proposal = { intent: "structure", summary: "Order the two steps", disposition: "changes", question: null, changes: [
      { kind: "update_task", targetId: first.id, title: "First step", rationale: "Clarify the action.", accepted: true },
      { kind: "add_dependency", taskId: first.id, dependsOnTaskId: second.id, rationale: "This would close a cycle.", accepted: true },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: parent.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/cycle/i);
    expect(getTaskOrThrow(ctx.handle.db, first.id).title).toBe("First");
  });

  it("rejects moves under direct or deep descendants during validation and permits an unrelated parent", () => {
    const project = createProject(ctx.handle.db, { title: "Move validation" });
    const root = createTask(ctx.handle.db, { projectId: project.id, title: "Root", status: "actionable" });
    const child = createChildTask(ctx.handle.db, root.id, { title: "Child", status: "actionable" });
    const grandchild = createChildTask(ctx.handle.db, child.id, { title: "Grandchild", status: "actionable" });
    const unrelated = createTask(ctx.handle.db, { projectId: project.id, title: "Unrelated parent", status: "actionable" });

    const createMoveJob = (targetId: number, parentTaskId: number) => {
      const id = randomUUID();
      const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
      const proposal = { intent: "structure", summary: "Reorder existing work", disposition: "changes", question: null, changes: [
        { kind: "move_task", targetId, parentTaskId, projectId: project.id, position: 0, rationale: "Place this step under its parent.", accepted: true },
      ] };
      ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
      return id;
    };

    for (const [targetId, proposedParentId] of [
      [root.id, child.id],
      [root.id, grandchild.id],
      [child.id, grandchild.id],
    ]) {
      const id = createMoveJob(targetId!, proposedParentId!);
      expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/hierarchy cycle/i);
      expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
      expect(ctx.handle.db.select({ parentId: schema.workItems.parentId }).from(schema.workItems).where(eq(schema.workItems.id, targetId!)).get()?.parentId).toBe(targetId === root.id ? project.id : root.id);
    }

    const validMoveId = createMoveJob(root.id, unrelated.id);
    applyWorkRefinement(ctx.handle.db, validMoveId, null, 1, {});
    expect(ctx.handle.db.select({ parentId: schema.workItems.parentId }).from(schema.workItems).where(eq(schema.workItems.id, root.id)).get()?.parentId).toBe(unrelated.id);
    expect(getIntake(ctx.handle.db, validMoveId, null).status).toBe("applied");
    expect(getTaskOrThrow(ctx.handle.db, child.id).parentTaskId).toBe(root.id);
  });

  it("rejects recurring-task children and external waits during proposal validation", () => {
    const task = createTask(ctx.handle.db, { title: "Daily check", status: "actionable", repeatAfterDays: 1, allowedDeviationDays: 0, scheduledDate: "2026-10-11" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, {
      intent: "structure", summary: "Add a recurring substep", disposition: "changes", question: null,
      changes: [{ kind: "create_child", parentTaskId: task.id, title: "Check the logs", rationale: "Useful action.", accepted: false }],
    });
    expect(getIntake(ctx.handle.db, id, null).status).toBe("analysis_failed");
    const waitId = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({ id: waitId, createdByMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, waitId)).get()!, {
      intent: "improve", summary: "Add external wait", disposition: "changes", question: null,
      changes: [{ kind: "update_wait", taskId: task.id, waitingFor: "Versicherung", rationale: "Pending reply.", accepted: false }],
    });
    expect(getIntake(ctx.handle.db, waitId, null).status).toBe("analysis_failed");
  });

  it("rolls back every accepted mutation when a later canonical operation fails", () => {
    const task = createTask(ctx.handle.db, { title: "Kita-Formular", status: "actionable" });
    const dependency = createChildTask(ctx.handle.db, task.id, { title: "Formular prüfen", status: "actionable" });
    const id = randomUUID();
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const proposal = { intent: "improve", summary: "Klarer machen", disposition: "changes", question: null, changes: [
      { kind: "update_task", targetId: task.id, title: "Kita-Formular im Sekretariat abgeben", rationale: "Macht den nächsten Schritt sichtbar.", accepted: true },
      { kind: "add_dependency", taskId: task.id, dependsOnTaskId: dependency.id, rationale: "Verknüpft die Prüfung.", accepted: true },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    ctx.handle.db.run(sql.raw("CREATE TRIGGER fail_dependency_event BEFORE INSERT ON activity_events WHEN NEW.kind = 'task_dependencies_changed' BEGIN SELECT RAISE(ABORT, 'test rollback'); END"));
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow();
    expect(getTaskOrThrow(ctx.handle.db, task.id).title).toBe("Kita-Formular");
    expect(ctx.handle.db.select().from(schema.taskDependencies).all()).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
  });
});

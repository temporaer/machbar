import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createChildTask, createTask, getTaskOrThrow } from "../src/domain/taskCrud.js";
import { createProject } from "../src/domain/storyCrud.js";
import { addDependency, upsertExternalWait } from "../src/domain/taskCapabilities.js";
import * as schema from "../src/db/schema.js";
import { onIntakeAnalyzed, getIntake } from "../src/intake/jobs.js";
import { applyWorkRefinement, assertRefinementContext, updateWorkRefinement } from "../src/intake/refinement.js";
import { buildRefinementSnapshot } from "../src/intake/refinementSnapshot.js";
import {
  normalizeWorkRefinementProposalInput,
  unacceptedWorkRefinementProposal,
  workRefinementProposalSchema,
} from "@machbar/shared";
import type { ProjectActivationResolution, WorkRefinementProposal } from "@machbar/shared";
import { closeTestContext, createTestContext, insertTestProject, type TestContext } from "./helpers.js";

describe("AI work refinement proposals", () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => closeTestContext(ctx));

  function resolutionFor(error: unknown, driverMemberId: number, nextActionTitle = "") : ProjectActivationResolution {
    const details = (error as { details?: { projects?: Array<{ projectId: number; required: string[] }>; expectedProjects?: ProjectActivationResolution["expectedProjects"] } }).details;
    if (!details?.projects || !details.expectedProjects) throw new Error("activation requirements were not returned");
    return {
      expectedProjects: details.expectedProjects,
      drivers: details.projects.filter((project) => project.required.includes("driver"))
        .map((project) => ({ projectId: project.projectId, ownerMemberId: driverMemberId })),
      ...(details.projects.some((project) => project.required.includes("progressPath")) ? { nextActionTitle } : {}),
    };
  }

  it.each([
    ["update_task", { targetId: 12, title: "Klarer", notes: null }],
    ["update_project", { targetId: 12, title: "Klarer", notes: null }],
    ["convert_task_to_project", { targetId: 12 }],
    ["create_child", { parentTaskId: 12, title: "Nächster Schritt", notes: null }],
    ["move_task", { targetId: 12, parentTaskId: null, projectId: null, position: 0 }],
    ["add_dependency", { taskId: 12, dependsOnTaskId: 13 }],
    ["update_wait", { taskId: 12, waitingFor: "Rückmeldung", revisitAt: null }],
    ["resolve_wait", { taskId: 12 }],
    ["cancel_task", { targetId: 12, descendantsPolicy: "leave_open" }],
    ["update_project_outcome", { projectId: 12, criterionId: null, outcome: "Erledigt, wenn sichtbar." }],
    ["advisory", { affectedIds: [12], title: "Prüfen" }],
  ] as const)("normalizes provider-nullable fields for %s", (kind, fields) => {
    const proposal = {
      intent: "improve",
      summary: "Vorschlag",
      disposition: "changes",
      question: null,
      changes: [{
        kind,
        rationale: "Macht den nächsten Schritt klar.",
        accepted: true,
        ...fields,
        ...(kind === "update_task" ? { projectId: null, waitingFor: null } : {}),
      }],
    };
    const normalized = normalizeWorkRefinementProposalInput(proposal);
    const result = workRefinementProposalSchema.safeParse(normalized);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.changes[0]?.accepted).toBe(false);
  });

  it("keeps non-null irrelevant fields for strict rejection", () => {
    const normalized = normalizeWorkRefinementProposalInput({
      intent: "improve",
      summary: "Vorschlag",
      disposition: "changes",
      question: null,
      changes: [{
        kind: "update_task",
        targetId: 12,
        title: "Klarer",
        rationale: "Macht den nächsten Schritt klar.",
        projectId: 99,
      }],
    });
    expect(workRefinementProposalSchema.safeParse(normalized).success).toBe(false);
  });

  it("does not accept a cancellation descendant policy from AI output", () => {
    const proposal = unacceptedWorkRefinementProposal({
      intent: "improve", summary: "Cancel obsolete work", disposition: "changes", question: null,
      changes: [{ kind: "cancel_task", targetId: 12, descendantsPolicy: "cancel_children", rationale: "The work is obsolete." }],
    });
    expect(proposal.changes[0]).toMatchObject({ kind: "cancel_task", accepted: false });
    expect(proposal.changes[0]).not.toHaveProperty("descendantsPolicy");
  });

  it("atomically converts a task, applies its reviewed title and notes, and creates two children", () => {
    const task = createTask(ctx.handle.db, { title: "Neue Haustür klären", notes: "Ursprüngliche Notiz", status: "captured" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const proposal = {
      intent: "structure", summary: "Aus der Auswahl wird ein umsetzbares Projekt.", disposition: "changes", question: null,
      changes: [
        { kind: "convert_task_to_project", targetId: task.id, rationale: "Mehrere Schritte sind nötig.", accepted: true },
        { kind: "update_task", targetId: task.id, title: "Haustür auswählen und montieren", notes: "Öffnung vor der Auswahl ausmessen.", rationale: "Der Projekttitel beschreibt das Ergebnis.", accepted: true },
        { kind: "create_child", parentTaskId: task.id, title: "Öffnung ausmessen", notes: null, rationale: "Die Maße werden für die Auswahl benötigt.", accepted: true },
        { kind: "create_child", parentTaskId: task.id, title: "Passende Haustür auswählen", notes: null, rationale: "Die Auswahl folgt auf die Maße.", accepted: true },
      ],
    };
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    applyWorkRefinement(ctx.handle.db, id, null, 1, {});

    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get();
    expect(project).toMatchObject({ id: task.id, role: "story", title: "Haustür auswählen und montieren", notes: "Öffnung vor der Auswahl ausmessen.", status: "backlog" });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Öffnung ausmessen", role: "task" }),
        expect.objectContaining({ title: "Passende Haustür auswählen", role: "task" }),
      ]));
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()).toHaveLength(2);
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "applied", refinement: { targetId: task.id } });
  });

  it("rejects unsupported conversion combinations and duplicate title writes before mutation", () => {
    const task = createTask(ctx.handle.db, { title: "Haustür", status: "captured" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const base = { intent: "structure" as const, summary: "Projekt mit einem nächsten Schritt.", disposition: "changes" as const, question: null };
    const conversion = { kind: "convert_task_to_project" as const, targetId: task.id, rationale: "Die Arbeit hat mehrere Schritte.", accepted: true };
    const unsupported: Array<WorkRefinementProposal["changes"][number]> = [
      { kind: "update_task", targetId: task.id, dueDate: "2026-11-01", rationale: "Eine Frist setzen.", accepted: true },
      { kind: "update_wait", taskId: task.id, waitingFor: "Rückmeldung", rationale: "Die Arbeit wartet.", accepted: true },
      { kind: "resolve_wait", taskId: task.id, rationale: "Das Warten beenden.", accepted: true },
      { kind: "move_task", targetId: task.id, parentTaskId: null, projectId: null, position: 0, rationale: "Die Aufgabe verschieben.", accepted: true },
      { kind: "cancel_task", targetId: task.id, rationale: "Die Aufgabe abbrechen.", accepted: true },
      { kind: "add_dependency", taskId: task.id, dependsOnTaskId: task.id + 1, rationale: "Eine Voraussetzung ergänzen.", accepted: true },
    ];
    for (const conflictingChange of unsupported) {
      const proposal = workRefinementProposalSchema.parse({ ...base, changes: [conversion, conflictingChange] });
      const expectedConflict = conflictingChange.kind === "update_task" ? "conversion_task_fields" : "conversion_operation";
      expect(() => assertRefinementContext(proposal, "task", task.id, snapshot, true)).toThrow(expect.objectContaining({
        code: "intake_draft_invalid", details: expect.objectContaining({ refinementConflict: expectedConflict, targetId: task.id }),
      }));
    }
    const taskFieldConflict = workRefinementProposalSchema.parse({ ...base, changes: [
      conversion,
      { kind: "update_task", targetId: task.id, title: "Haustür kaufen", scheduledDate: "2026-11-01", rationale: "Planung gehört zur Aufgabe.", accepted: true },
    ] });
    expect(() => assertRefinementContext(taskFieldConflict, "task", task.id, snapshot, true)).toThrow(expect.objectContaining({
      code: "intake_draft_invalid", details: expect.objectContaining({ refinementConflict: "conversion_task_fields", targetId: task.id }),
    }));
    const duplicateTitle = workRefinementProposalSchema.parse({ ...base, changes: [
      { kind: "update_task", targetId: task.id, title: "Haustür auswählen", rationale: "Konkretisieren.", accepted: true },
      { kind: "update_task", targetId: task.id, title: "Haustür montieren", rationale: "Anders konkretisieren.", accepted: true },
    ] });
    expect(() => assertRefinementContext(duplicateTitle, "task", task.id, snapshot, true)).toThrow(expect.objectContaining({
      code: "intake_draft_invalid", details: { refinementConflict: "duplicate_text_field", targetId: task.id, field: "title" },
    }));
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ title: "Haustür", status: "captured", children: [] });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()?.role).toBe("task");
  });

  it("rejects unknown and cyclic proposal-local parent references", () => {
    const snapshot = { id: 12, revision: 1, title: "Project", status: "active", tasks: [], projects: [] };
    const base = { intent: "structure" as const, summary: "Nested", disposition: "changes" as const, question: null };
    const unknown = workRefinementProposalSchema.parse({ ...base, changes: [
      { kind: "create_child", proposalKey: "child", parentProposalKey: "missing", title: "Child", rationale: "A step." },
    ] });
    expect(() => assertRefinementContext(unknown, "project", 12, snapshot)).toThrow(/unknown proposed parent/i);
    const cyclic = workRefinementProposalSchema.parse({ ...base, changes: [
      { kind: "create_child", proposalKey: "one", parentProposalKey: "two", title: "One", rationale: "A step." },
      { kind: "create_child", proposalKey: "two", parentProposalKey: "one", title: "Two", rationale: "A step." },
    ] });
    expect(() => assertRefinementContext(cyclic, "project", 12, snapshot)).toThrow(/hierarchy contains a cycle/i);
  });

  it("distinguishes provider null placeholders from explicit reminder clearing", () => {
    const normalized = normalizeWorkRefinementProposalInput({
      intent: "improve", summary: "Keep existing planning", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 12, scheduledDate: null, dueDate: null, revisitAt: null, reminders: null, rationale: "No planning changes." }],
    }) as { changes: Array<Record<string, unknown>> };
    expect(normalized.changes[0]).not.toHaveProperty("scheduledDate");
    expect(normalized.changes[0]).not.toHaveProperty("dueDate");
    expect(normalized.changes[0]).not.toHaveProperty("revisitAt");
    expect(normalized.changes[0]).not.toHaveProperty("reminders");
    const explicitClear = normalizeWorkRefinementProposalInput({
      intent: "improve", summary: "Clear reminders", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 12, reminders: [], rationale: "Remove the old reminders." }],
    }) as { changes: Array<Record<string, unknown>> };
    expect(explicitClear.changes[0]?.reminders).toEqual([]);
    expect(workRefinementProposalSchema.safeParse(explicitClear).success).toBe(true);

    const explicitDateClear = normalizeWorkRefinementProposalInput({
      intent: "improve", summary: "Clear obsolete dates", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 12, clearScheduledDate: true, clearDueDate: true, clearRevisitAt: true, rationale: "The dates no longer apply." }],
    }) as { changes: Array<Record<string, unknown>> };
    expect(explicitDateClear.changes[0]).toMatchObject({ scheduledDate: null, dueDate: null, revisitAt: null });
    expect(explicitDateClear.changes[0]).not.toHaveProperty("clearScheduledDate");
    expect(explicitDateClear.changes[0]).not.toHaveProperty("clearDueDate");
    expect(explicitDateClear.changes[0]).not.toHaveProperty("clearRevisitAt");
    expect(workRefinementProposalSchema.safeParse(explicitDateClear).success).toBe(true);
    const conflictingClear = normalizeWorkRefinementProposalInput({
      intent: "improve", summary: "Conflicting date", disposition: "changes", question: null,
      changes: [{ kind: "update_task", targetId: 12, scheduledDate: "2026-10-13", clearScheduledDate: true, rationale: "Conflicting instructions." }],
    });
    expect(workRefinementProposalSchema.safeParse(conflictingClear).success).toBe(false);
  });

  it("compacts optional nested-parent and cancellation decision placeholders", () => {
    const normalized = normalizeWorkRefinementProposalInput({
      intent: "structure", summary: "Add one step", disposition: "changes", question: null,
      changes: [
        { kind: "create_child", parentTaskId: 12, proposalKey: null, parentProposalKey: null, title: "Prepare", rationale: "A useful first step." },
        { kind: "cancel_task", targetId: 13, descendantsPolicy: null, rationale: "This action is obsolete." },
      ],
    }) as { changes: Array<Record<string, unknown>> };
    expect(normalized.changes[0]).not.toHaveProperty("proposalKey");
    expect(normalized.changes[0]).not.toHaveProperty("parentProposalKey");
    expect(normalized.changes[1]).not.toHaveProperty("descendantsPolicy");
    expect(workRefinementProposalSchema.safeParse(normalized).success).toBe(true);
  });

  it("normalizes the synthetic cellar-staircase provider fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../packages/shared/fixtures/work-refinement/cellar-staircase-1000000348.json", import.meta.url), "utf8")) as unknown;
    const normalized = normalizeWorkRefinementProposalInput(fixture);
    const result = workRefinementProposalSchema.safeParse(normalized);
    expect(result.success).toBe(true);
    if (result.success) {
      const change = result.data.changes[0];
      expect(change?.accepted).toBe(false);
      expect(change).not.toHaveProperty("projectId");
      expect(change).not.toHaveProperty("waitingFor");
      if (change?.kind === "update_project") {
        expect(change.targetId).toBe(1000000348);
      }
    }
  });

  it("accepts the synthetic cellar-staircase project refinement end to end", () => {
    const project = insertTestProject(ctx.handle.db, { id: 1000000348, title: "Kellertreppe", status: "backlog" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const id = randomUUID();
    const proposal = JSON.parse(readFileSync(new URL("../../../packages/shared/fixtures/work-refinement/cellar-staircase-1000000348.json", import.meta.url), "utf8")) as unknown;
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1,
      text: snapshot, refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "improve",
      refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, proposal);

    const ready = getIntake(ctx.handle.db, id, null);
    expect(ready.status).toBe("ready");
    expect(ready.refinement?.proposal?.changes[0]?.accepted).toBe(false);
  });

  it("persists field-level diagnostics for invalid refinement proposals", () => {
    const task = createTask(ctx.handle.db, { title: "Cellar staircase", status: "actionable" });
    const id = randomUUID();
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve",
      refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, {
      intent: "improve",
      summary: "Klarer machen",
      disposition: "changes",
      question: null,
      changes: [{ kind: "update_task", rationale: "Der nächste Schritt wird sichtbar." }],
    });

    const failed = getIntake(ctx.handle.db, id, null);
    expect(failed.status).toBe("analysis_failed");
    expect(failed.error?.code).toBe("intake_plan_invalid");
    expect(failed.error?.details?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["changes", 0, "targetId"],
        code: "schema_invalid",
      }),
    ]));

    const mismatchId = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id: mismatchId, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve",
      refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, mismatchId)).get()!, {
      intent: "structure", summary: "Andere Absicht", disposition: "leave_alone", question: null, changes: [],
    });
    const mismatch = getIntake(ctx.handle.db, mismatchId, null);
    expect(mismatch.error?.message).toContain("wrong intent");
    expect(mismatch.error?.details?.issues?.[0]?.path).toEqual(["intent"]);
  });

  it("passes persisted refinement issues into corrective retry instructions", async () => {
    const task = createTask(ctx.handle.db, { title: "Cellar staircase", status: "actionable" });
    const id = randomUUID();
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const now = new Date().toISOString();
    ctx.handle.db.insert(schema.homeAssistantIntegrations).values({
      instanceId: "retry-test",
      tokenHash: "retry-test-token",
      protocolVersion: 3,
      connectedAt: now,
      capabilitiesJson: JSON.stringify({ intake: { aiTask: { state: "ok" } } }),
    }).run();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve",
      refinementSnapshotJson: snapshot, createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, {
      intent: "improve",
      summary: "Klarer machen",
      disposition: "changes",
      question: null,
      changes: [{ kind: "update_task", rationale: "Der nächste Schritt wird sichtbar." }],
    });

    const response = await ctx.app.inject({ method: "POST", url: `/api/intake/${id}/retry` });
    expect(response.statusCode).toBe(200);
    const request = ctx.handle.db.select().from(schema.homeAssistantRequests)
      .where(eq(schema.homeAssistantRequests.intakeJobId, id))
      .get();
    expect(request).toBeDefined();
    const instructions = JSON.parse(request!.payloadJson).instructions as string;
    expect(instructions).toContain("changes[0].targetId");
    expect(instructions).toContain("Required");
  });

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

  it("creates a nested child outline in dependency-safe order and rolls back unchecked parents", () => {
    const project = insertTestProject(ctx.handle.db, { title: "Kita vorbereiten", status: "active" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const id = randomUUID();
    const proposal = {
      intent: "structure", summary: "Drei sinnvolle Schritte", disposition: "changes", question: null,
      changes: [
        { kind: "create_child", parentTaskId: project.id, proposalKey: "choose", title: "Vorbereitung planen", rationale: "Erst den Rahmen klären.", accepted: true },
        { kind: "create_child", parentTaskId: project.id, proposalKey: "buy", title: "Material besorgen", rationale: "Ein paralleler Schritt.", accepted: true },
        { kind: "create_child", parentProposalKey: "choose", proposalKey: "dimensions", title: "Maße prüfen", rationale: "Die Planung braucht Maße.", accepted: true },
      ],
    };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    const created = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all();
    const root = created.find((item) => item.title === "Vorbereitung planen")!;
    expect(created.map((item) => item.title)).toContain("Material besorgen");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, root.id)).all().map((item) => item.title)).toEqual(["Maße prüfen"]);

    const uncheckedId = randomUUID();
    const refreshed = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const beforeCount = ctx.handle.db.select().from(schema.workItems).all().length;
    ctx.handle.db.insert(schema.intakeJobs).values({ id: uncheckedId, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: refreshed, refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "structure", refinementSnapshotJson: refreshed, refinementJson: JSON.stringify({ ...proposal, changes: [proposal.changes[0] && { ...proposal.changes[0], accepted: false }, proposal.changes[2]] }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, uncheckedId, null, 1, {})).toThrow(/accept the proposed parent/i);
    expect(ctx.handle.db.select().from(schema.workItems).all()).toHaveLength(beforeCount);
    expect(getIntake(ctx.handle.db, uncheckedId, null).status).toBe("ready");
  });

  it("rolls back every created outline item when a later nested child fails", () => {
    const project = insertTestProject(ctx.handle.db, { title: "Sicherungen", status: "active" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const id = randomUUID();
    const proposal = { intent: "structure", summary: "Backup testen", disposition: "changes", question: null, changes: [
      { kind: "create_child", parentTaskId: project.id, proposalKey: "restore", title: "Wiederherstellung planen", rationale: "Ein erster Schritt.", accepted: true },
      { kind: "create_child", parentProposalKey: "restore", proposalKey: "file", title: "Fehler erzwingen", rationale: "Löst den Testfehler aus.", accepted: true },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    ctx.handle.db.run(sql.raw("CREATE TRIGGER fail_second_outline_item BEFORE INSERT ON work_items WHEN NEW.title = 'Fehler erzwingen' BEGIN SELECT RAISE(ABORT, 'forced nested create failure'); END"));
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/forced nested create failure/i);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all()).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
    ctx.handle.db.run(sql.raw("DROP TRIGGER fail_second_outline_item"));
    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    const firstLevel = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all();
    expect(firstLevel.map((item) => item.title)).toEqual(["Wiederherstellung planen"]);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, firstLevel[0]!.id)).all().map((item) => item.title)).toEqual(["Fehler erzwingen"]);
  });

  it("starts, updates, and resolves external waits through canonical wait operations", () => {
    const task = createTask(ctx.handle.db, {
      title: "Versicherung prüfen", status: "actionable", scheduledDate: "2026-11-05", dueDate: "2026-11-10",
      reminders: [{ kind: "absolute", at: "2026-11-04T09:00:00.000Z" }],
    });
    const makeJob = (proposal: unknown, snapshot: string) => {
      const id = randomUUID();
      ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
      applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    };
    const firstSnapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    makeJob({ intent: "improve", summary: "Rückmeldung erwarten", disposition: "changes", question: null, changes: [{ kind: "update_wait", taskId: task.id, waitingFor: "Schadenübernahme bestätigen", revisitAt: "2026-11-01T09:00:00.000Z", rationale: "Die erwartete Antwort und Wiedervorlage sind klar.", accepted: true }] }, firstSnapshot);
    expect(ctx.handle.db.select().from(schema.taskExternalWaits).where(eq(schema.taskExternalWaits.taskId, task.id)).get()?.waitingFor).toBe("Schadenübernahme bestätigen");
    const updateSnapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    makeJob({ intent: "improve", summary: "Rückmeldung präzisieren", disposition: "changes", question: null, changes: [{ kind: "update_wait", taskId: task.id, waitingFor: "Schadenübernahme für die Reparatur bestätigen", revisitAt: "2026-11-03T09:00:00.000Z", rationale: "Der erwartete Inhalt ist nun klarer.", accepted: true }] }, updateSnapshot);
    expect(ctx.handle.db.select().from(schema.taskExternalWaits).where(eq(schema.taskExternalWaits.taskId, task.id)).get()?.waitingFor).toBe("Schadenübernahme für die Reparatur bestätigen");
    const resolveSnapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    makeJob({ intent: "improve", summary: "Antwort ist eingetroffen", disposition: "changes", question: null, changes: [{ kind: "resolve_wait", taskId: task.id, rationale: "Die erwartete Antwort liegt vor.", accepted: true }] }, resolveSnapshot);
    expect(ctx.handle.db.select().from(schema.taskExternalWaits).where(eq(schema.taskExternalWaits.taskId, task.id)).get()).toBeUndefined();
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({
      status: "actionable", scheduledDate: "2026-11-05", dueDate: "2026-11-10", revisitAt: null,
      reminders: [{ kind: "absolute", at: "2026-11-04T09:00:00.000Z" }],
    });
  });

  it("requires a reviewed descendants policy before cancelling and applies the chosen policy atomically", () => {
    const task = createTask(ctx.handle.db, { title: "Altes Vorhaben", status: "actionable" });
    const child = createChildTask(ctx.handle.db, task.id, { title: "Offener Teilschritt", status: "actionable" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const proposal = { intent: "improve", summary: "Nicht mehr benötigt", disposition: "changes", question: null, changes: [{ kind: "cancel_task", targetId: task.id, rationale: "Das Vorhaben ist überholt.", accepted: true }] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/descendants policy/i);
    expect(getTaskOrThrow(ctx.handle.db, task.id).status).toBe("actionable");
    expect(getTaskOrThrow(ctx.handle.db, child.id).status).toBe("actionable");
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
    const reviewed = { ...proposal, changes: [{ ...proposal.changes[0]!, descendantsPolicy: "cancel_children" }] };
    updateWorkRefinement(ctx.handle.db, id, null, 1, reviewed);
    applyWorkRefinement(ctx.handle.db, id, null, 2, {});
    expect(getTaskOrThrow(ctx.handle.db, task.id).status).toBe("cancelled");
    expect(getTaskOrThrow(ctx.handle.db, child.id).status).toBe("cancelled");
  });

  it.each([
    ["leave_open", "actionable"],
    ["cancel_children", "cancelled"],
    ["complete_children", "done"],
  ] as const)("applies the reviewed %s cancellation policy to open descendants", (descendantsPolicy, childStatus) => {
    const task = createTask(ctx.handle.db, { title: `Obsolete ${descendantsPolicy}`, status: "actionable" });
    const child = createChildTask(ctx.handle.db, task.id, { title: "Open child", status: "actionable" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const proposal = { intent: "improve", summary: "No longer needed", disposition: "changes", question: null, changes: [{ kind: "cancel_task", targetId: task.id, descendantsPolicy, rationale: "The task is obsolete.", accepted: true }] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    expect(getTaskOrThrow(ctx.handle.db, child.id).status).toBe(childStatus);
  });

  it("rejects a cancellation when a descendant changed after the reviewed snapshot", () => {
    const task = createTask(ctx.handle.db, { title: "Obsolete tree", status: "actionable" });
    const child = createChildTask(ctx.handle.db, task.id, { title: "Reviewed descendant", status: "actionable" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify({ intent: "improve", summary: "Cancel the obsolete tree", disposition: "changes", question: null, changes: [{ kind: "cancel_task", targetId: task.id, descendantsPolicy: "cancel_children", rationale: "The whole tree is obsolete.", accepted: true }] }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    ctx.handle.db.update(schema.workItems).set({ revision: sql`${schema.workItems.revision} + 1` }).where(eq(schema.workItems.id, child.id)).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(/outline changed/i);
    expect(getTaskOrThrow(ctx.handle.db, task.id).status).toBe("actionable");
    expect(getTaskOrThrow(ctx.handle.db, child.id).status).toBe("actionable");
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");
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

  it("adds a child to a captured task through canonical first-child classification", () => {
    const task = createTask(ctx.handle.db, { title: "Neue Haustür", status: "captured" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, status: "captured", kind: "action", parentTaskId: null, projectId: null, externalWait: null, dependencies: [], repeatAfterDays: null, reminders: [], children: [] });
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "analyzing", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    onIntakeAnalyzed(ctx.handle.db, ctx.handle.db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get()!, {
      intent: "structure", summary: "Mache das Vorhaben zu einem Projekt.", disposition: "changes", question: null,
      changes: [
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
    expect(converted.role).toBe("task");
    expect(converted.status).toBe("active");
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all().map((row) => row.title)).toEqual(["Klären, ob noch die Auswahl oder nur die Montage ansteht"]);
  });

  it("applies accepted task planning and reminders through canonical mutations", () => {
    const task = createTask(ctx.handle.db, { title: "Durchsichtigen Plastikbehälter für das Laternenbasteln vorbereiten", status: "captured" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const tuesdayReminder = "2026-10-13T05:00:00.000Z"; // 07:00 in Europe/Berlin on Tuesday, 2026-10-13.
    const mondayReminder = "2026-10-19T05:00:00.000Z"; // 07:00 in Europe/Berlin on Monday, 2026-10-19.
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "improve", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({
        intent: "improve", summary: "Plan the work and its reminders", disposition: "changes", question: null,
        changes: [
          { kind: "update_task", targetId: task.id, title: "Durchsichtigen Plastikbehälter am Dienstag zur Kita mitbringen", scheduledDate: "2026-10-13", reminders: [{ kind: "absolute", at: tuesdayReminder }], rationale: "Keep the existing task identity for Tuesday's bring action.", accepted: true },
          { kind: "create_child", parentTaskId: task.id, title: "Zweiten Plastikbehälter am Montag zur Kita mitbringen", scheduledDate: "2026-10-19", reminders: [{ kind: "absolute", at: mondayReminder }], rationale: "Add the second dated bring action without recurrence.", accepted: true },
        ],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    const updated = getTaskOrThrow(ctx.handle.db, task.id);
    const child = updated.children[0]!;
    expect(updated).toMatchObject({ title: "Durchsichtigen Plastikbehälter am Dienstag zur Kita mitbringen", scheduledDate: "2026-10-13", dueDate: null, status: "actionable" });
    expect(child).toMatchObject({ title: "Zweiten Plastikbehälter am Montag zur Kita mitbringen", scheduledDate: "2026-10-19", dueDate: null });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).all()).toEqual([expect.objectContaining({ kind: "absolute", at: tuesdayReminder })]);
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, child.id)).all()).toEqual([expect.objectContaining({ kind: "absolute", at: mondayReminder })]);
  });

  it("preserves omitted planning fields and accepts explicit null and empty-array clears", () => {
    const task = createTask(ctx.handle.db, {
      title: "Follow up", status: "actionable", scheduledDate: "2026-10-13", dueDate: "2026-10-19",
      reminders: [
        { kind: "absolute", at: "2026-10-11T05:00:00.000Z" },
        { kind: "deadline_relative", daysBefore: 1, time: "07:00", timezone: "Europe/Berlin" },
      ],
    });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot,
      refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "improve", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({ intent: "improve", summary: "Update only the title", disposition: "changes", question: null, changes: [
        { kind: "update_task", targetId: task.id, title: "Follow up with the office", rationale: "Clarify the action.", accepted: true },
      ] }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();
    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ title: "Follow up with the office", scheduledDate: "2026-10-13", dueDate: "2026-10-19" });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, task.id)).all()).toHaveLength(2);

    const applyProviderClear = (target: ReturnType<typeof createTask>, clearFields: Record<string, unknown>, summary: string) => {
      const targetSnapshot = buildRefinementSnapshot(ctx.handle.db, "task", target.id, null).snapshot;
      const clearId = randomUUID();
      const providerProposal = workRefinementProposalSchema.parse(normalizeWorkRefinementProposalInput({
        intent: "improve", summary, disposition: "changes", question: null,
        changes: [{ kind: "update_task", targetId: target.id, ...clearFields, rationale: summary }],
      }));
      const acceptedProposal = {
        ...providerProposal,
        changes: providerProposal.changes.map((change) => ({ ...change, accepted: true })),
      };
      ctx.handle.db.insert(schema.intakeJobs).values({
        id: clearId, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: targetSnapshot,
        refinementTargetType: "task", refinementTargetId: target.id, refinementIntent: "improve", refinementSnapshotJson: targetSnapshot,
        refinementJson: JSON.stringify(acceptedProposal),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }).run();
      applyWorkRefinement(ctx.handle.db, clearId, null, 1, {});
    };

    const clearableDates = createTask(ctx.handle.db, {
      title: "Clear obsolete dates", status: "actionable", scheduledDate: "2026-10-13", dueDate: "2026-10-19",
      reminders: [{ kind: "absolute", at: "2026-10-11T05:00:00.000Z" }],
    });
    applyProviderClear(clearableDates, { clearScheduledDate: true, clearDueDate: true, reminders: [] }, "Remove obsolete planned and deadline dates.");
    expect(getTaskOrThrow(ctx.handle.db, clearableDates.id)).toMatchObject({ scheduledDate: null, dueDate: null, revisitAt: null, reminders: [] });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, clearableDates.id)).all()).toEqual([]);

    const revisitable = createTask(ctx.handle.db, { title: "Revisit", status: "actionable", revisitAt: "2026-10-12T05:00:00.000Z", reminders: [{ kind: "absolute", at: "2026-10-11T05:00:00.000Z" }] });
    applyProviderClear(revisitable, { clearRevisitAt: true, reminders: [] }, "Remove the old revisit and reminder.");
    expect(getTaskOrThrow(ctx.handle.db, revisitable.id)).toMatchObject({ revisitAt: null, scheduledDate: null, dueDate: null, reminders: [] });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, revisitable.id)).all()).toEqual([]);
  });

  it("rolls back all accepted changes when a second planning change is invalid", () => {
    const project = createProject(ctx.handle.db, { title: "Planning target" });
    const projectRevision = project.revision;
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot,
      refinementTargetType: "project", refinementTargetId: project.id, refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({ intent: "structure", summary: "Two operations", disposition: "changes", question: null, changes: [
        { kind: "create_child", parentTaskId: project.id, title: "Valid first action", scheduledDate: "2026-10-13", reminders: [{ kind: "absolute", at: "2026-10-12T05:00:00.000Z" }], rationale: "First selected action.", accepted: true },
        { kind: "create_child", parentTaskId: project.id, title: "Conflicting second action", scheduledDate: "2026-10-19", revisitAt: "2026-10-18T05:00:00.000Z", rationale: "A work date and revisit cannot coexist on an ordinary task.", accepted: true },
      ] }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();
    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow();
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toHaveLength(0);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, project.id)).get()?.revision).toBe(projectRevision);
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "ready", revision: 1 });
  });

  it("collects activation decisions for a dated child and retries atomically without duplicate work or reminders", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Project driver", color: "#456789" }).returning().get();
    const project = insertTestProject(ctx.handle.db, { title: "Laternenbasteln", status: "backlog" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "project", project.id, null).snapshot;
    const id = randomUUID();
    const reminder = { kind: "absolute", at: "2026-10-12T05:00:00.000Z" };
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "project", refinementTargetId: project.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({ intent: "structure", summary: "Plan the two concrete actions", disposition: "changes", question: null, changes: [
        { kind: "create_child", parentTaskId: project.id, title: "Behälter am Dienstag mitbringen", scheduledDate: "2026-10-13", reminders: [reminder], rationale: "Bring the container to daycare on Tuesday.", accepted: true },
      ] }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    expect(requirements).toMatchObject({ code: "project_commitment_resolution_required" });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all()).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "ready", revision: 1 });

    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id, "Behälter vorbereiten"));
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).get()!;
    expect(child).toMatchObject({ title: "Behälter am Dienstag mitbringen", status: "active", scheduledDate: "2026-10-13" });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, child.id)).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, project.id)).all()).toHaveLength(1);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("activates an actionable conversion with the selected driver without assigning children to that driver", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
    const task = createTask(ctx.handle.db, { title: "Sommerfest", status: "actionable" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({
        intent: "structure", summary: "Make the plan actionable.", disposition: "changes", question: null,
        changes: [
          { kind: "convert_task_to_project", targetId: task.id, rationale: "Several steps are needed.", accepted: true },
          { kind: "create_child", parentTaskId: task.id, title: "Choose a date", notes: null, rationale: "Start with the first decision.", accepted: true },
        ],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id));
    const converted = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!;
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).get()!;
    expect(converted.role).toBe("story");
    expect(converted.status).toBe("active");
    expect(converted.ownerMemberId).toBe(driver.id);
    expect(child.ownerMemberId).toBeNull();
  });

  it("activates conversion for a commitment on a proposed grandchild and retries without duplicates", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Nested driver", color: "#987654" }).returning().get();
    const task = createTask(ctx.handle.db, { title: "Kita-Termin vorbereiten", status: "someday" });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const reminder = { kind: "absolute" as const, at: "2026-10-13T07:00:00.000Z" };
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({
        intent: "structure", summary: "Vorbereitung mit konkretem Bringeschritt", disposition: "changes", question: null,
        changes: [
          { kind: "convert_task_to_project", targetId: task.id, rationale: "Die Arbeit hat mehrere Schritte.", accepted: true },
          { kind: "create_child", parentTaskId: task.id, proposalKey: "prepare", title: "Unterlagen vorbereiten", rationale: "Zuerst vorbereiten.", accepted: true },
          { kind: "create_child", parentProposalKey: "prepare", proposalKey: "bring", title: "Unterlagen am Mittwoch mitbringen", scheduledDate: "2026-10-14", reminders: [reminder], rationale: "Der Termin ist verbindlich.", accepted: true },
        ],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    expect(requirements).toMatchObject({ code: "project_commitment_resolution_required" });
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ kind: "action", status: "someday", children: [] });
    expect(ctx.handle.db.select().from(schema.taskReminders).all()).toHaveLength(0);
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "ready", revision: 1 });

    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id, "Kita-Termin abstimmen"));
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!;
    const child = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).get()!;
    const grandchild = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, child.id)).get()!;
    expect(project).toMatchObject({ role: "story", status: "active", ownerMemberId: driver.id });
    expect(grandchild).toMatchObject({ title: "Unterlagen am Mittwoch mitbringen", status: "active", scheduledDate: "2026-10-14" });
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, grandchild.id)).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()).toHaveLength(1);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("uses an existing captured-task execution commitment to request a driver during typed conversion", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Refinement driver", color: "#234567" }).returning().get();
    const task = createTask(ctx.handle.db, { title: "Prepare the move", status: "captured" });
    ctx.handle.db.update(schema.workItems).set({ dueDate: "2030-12-01" }).where(eq(schema.workItems.id, task.id)).run();
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({
        intent: "structure", summary: "Make the work resumable.", disposition: "changes", question: null,
        changes: [
          { kind: "convert_task_to_project", targetId: task.id, rationale: "Separate the commitment from its steps.", accepted: true },
          { kind: "create_child", parentTaskId: task.id, title: "Confirm the moving date", notes: null, rationale: "This is the first concrete step.", accepted: true },
        ],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    expect(() => applyWorkRefinement(ctx.handle.db, id, null, 1, {})).toThrow(expect.objectContaining({
      code: "project_commitment_resolution_required",
    }));
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ kind: "action", status: "captured", dueDate: "2030-12-01", children: [] });
    expect(getIntake(ctx.handle.db, id, null).status).toBe("ready");

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id));
    const project = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get()!;
    expect(project).toMatchObject({ role: "story", status: "active", ownerMemberId: driver.id });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: "Confirm the moving date" })]));
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()
      .filter((child) => child.title === "Confirm the moving date")).toHaveLength(1);
  });

  it("uses canonical conversion to preserve revisit, reminders, external waits, and dependencies", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
    const prerequisite = createTask(ctx.handle.db, { title: "Get the documents", status: "actionable" });
    const task = createTask(ctx.handle.db, {
      title: "Insurance follow-up", status: "actionable", revisitAt: "2027-04-03T09:00:00.000Z",
      reminders: [{ kind: "absolute", at: "2027-04-02T09:00:00.000Z" }],
    });
    upsertExternalWait(ctx.handle.db, task.id, { waitingFor: "Insurance response", revisitAt: "2027-04-03T09:00:00.000Z" });
    addDependency(ctx.handle.db, task.id, prerequisite.id);
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    const proposal = {
      intent: "structure", summary: "Clarify the follow-up plan", disposition: "changes", question: null,
      changes: [
        { kind: "convert_task_to_project", targetId: task.id, rationale: "A project is useful for the response and follow-up.", accepted: true },
        { kind: "create_child", parentTaskId: task.id, title: "Check the response against the policy", notes: null, rationale: "This advances the work once the response arrives.", accepted: true },
      ],
    };
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id));
    const preserved = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()
      .find((child) => child.title === task.title)!;
    expect(preserved.revisitAt).toBe("2027-04-03T09:00:00.000Z");
    expect(ctx.handle.db.select().from(schema.taskExternalWaits).where(eq(schema.taskExternalWaits.taskId, preserved.id)).get()?.waitingFor).toBe("Insurance response");
    expect(ctx.handle.db.select().from(schema.taskReminders).where(eq(schema.taskReminders.taskId, preserved.id)).all()).toHaveLength(1);
    expect(ctx.handle.db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, preserved.id)).get()?.dependsOnTaskId).toBe(prerequisite.id);
  });

  it("collects a progress-path decision for typed conversion and retries atomically", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Project driver", color: "#345678" }).returning().get();
    const task = createTask(ctx.handle.db, {
      title: "Haustür montieren",
      status: "actionable",
      ownerMemberId: driver.id,
      ownerInheritanceMode: "explicit",
    });
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({
        intent: "structure", summary: "Work is ready to organize.", disposition: "changes", question: null,
        changes: [{ kind: "convert_task_to_project", targetId: task.id, rationale: "The work needs a visible next action.", accepted: true }],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    expect(requirements).toMatchObject({
      code: "project_commitment_resolution_required",
      details: { projects: [{ projectId: task.id, required: ["progressPath"] }] },
    });
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ status: "actionable", ownerMemberId: driver.id, children: [] });
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "ready", revision: 1 });

    const staleResolution = resolutionFor(requirements, driver.id, "Nächsten Schritt festlegen");
    staleResolution.expectedProjects = staleResolution.expectedProjects.map((project) => ({ ...project, revision: project.revision + 1 }));
    let staleError: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}, staleResolution); } catch (error) { staleError = error; }
    expect(staleError).toMatchObject({ code: "project_commitment_resolution_required", details: { reason: "project_snapshot_stale" } });
    expect(getTaskOrThrow(ctx.handle.db, task.id)).toMatchObject({ status: "actionable", children: [] });
    expect(getIntake(ctx.handle.db, id, null)).toMatchObject({ status: "ready", revision: 1 });

    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id, "Montage-Termin abstimmen"));
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, task.id)).get())
      .toMatchObject({ role: "story", status: "active", ownerMemberId: driver.id });
    expect(ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()
      .filter((child) => child.title === "Montage-Termin abstimmen")).toHaveLength(1);
    expect(getIntake(ctx.handle.db, id, null).status).toBe("applied");
  });

  it("preserves supported recurrence configuration and occurrence history through AI conversion", () => {
    const driver = ctx.handle.db.insert(schema.members).values({ name: "Driver", color: "#123456" }).returning().get();
    const task = createTask(ctx.handle.db, { title: "Monthly maintenance", status: "actionable" });
    ctx.handle.db.update(schema.workItems).set({ repeatAfterDays: 30, allowedDeviationDays: 3 })
      .where(eq(schema.workItems.id, task.id)).run();
    const occurrence = ctx.handle.db.insert(schema.taskRecurrenceOccurrences).values({
      taskId: task.id, scheduledDate: "2026-09-01", deadlineDate: "2026-09-04",
      completedOn: "2026-09-01", completedAt: "2026-09-01T12:00:00.000Z", result: "hit",
    }).returning().get();
    const snapshot = buildRefinementSnapshot(ctx.handle.db, "task", task.id, null).snapshot;
    const id = randomUUID();
    ctx.handle.db.insert(schema.intakeJobs).values({
      id, createdByMemberId: null, actorMemberId: null, scope: "household", status: "ready", revision: 1,
      text: snapshot, refinementTargetType: "task", refinementTargetId: task.id,
      refinementIntent: "structure", refinementSnapshotJson: snapshot,
      refinementJson: JSON.stringify({ intent: "structure", summary: "Separate the ongoing upkeep", disposition: "changes", question: null, changes: [
        { kind: "convert_task_to_project", targetId: task.id, rationale: "The work also has a finite improvement outcome.", accepted: true },
        { kind: "create_child", parentTaskId: task.id, title: "Review the current setup", notes: null, rationale: "Identify the first improvement.", accepted: true },
      ] }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }).run();

    let requirements: unknown;
    try { applyWorkRefinement(ctx.handle.db, id, null, 1, {}); } catch (error) { requirements = error; }
    applyWorkRefinement(ctx.handle.db, id, null, 1, {}, resolutionFor(requirements, driver.id));
    const preserved = ctx.handle.db.select().from(schema.workItems).where(eq(schema.workItems.parentId, task.id)).all()
      .find((child) => child.title === task.title)!;
    expect(preserved).toMatchObject({ repeatAfterDays: 30, allowedDeviationDays: 3 });
    expect(ctx.handle.db.select().from(schema.taskRecurrenceOccurrences).where(eq(schema.taskRecurrenceOccurrences.id, occurrence.id)).get()?.taskId).toBe(preserved.id);
  });

  it("allows excluding an optional project conversion while keeping a selected captured-task child", () => {
    const task = createTask(ctx.handle.db, { title: "Neue Haustür", status: "captured" });
    const id = randomUUID();
    const snapshot = JSON.stringify({ id: task.id, revision: task.revision, title: task.title, status: "captured", kind: "action", parentTaskId: null, projectId: null, externalWait: null, dependencies: [], repeatAfterDays: null, reminders: [], children: [] });
    const proposal = { intent: "structure", summary: "Ein erster Schritt.", disposition: "changes", question: null, changes: [
      { kind: "create_child", parentTaskId: task.id, title: "Montage klären", rationale: "Ein nächster Schritt.", accepted: true },
      { kind: "convert_task_to_project", targetId: task.id, rationale: "Ermöglicht Unteraufgaben.", accepted: false },
    ] };
    ctx.handle.db.insert(schema.intakeJobs).values({ id, createdByMemberId: null, scope: "household", status: "ready", revision: 1, text: snapshot, refinementTargetType: "task", refinementTargetId: task.id, refinementIntent: "structure", refinementSnapshotJson: snapshot, refinementJson: JSON.stringify(proposal), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }).run();
    applyWorkRefinement(ctx.handle.db, id, null, 1, {});
    expect(getTaskOrThrow(ctx.handle.db, task.id).status).toBe("actionable");
    expect(getTaskOrThrow(ctx.handle.db, task.id).children.map((child) => child.title)).toEqual(["Montage klären"]);
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

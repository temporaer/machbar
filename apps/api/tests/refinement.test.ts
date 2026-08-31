import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import {
  addDependency,
  createProject,
  createTask,
  moveTask,
  updateTask,
} from "../src/domain/mutations.js";
import {
  getRefinementOwnerSizeCounts,
  getRefinementTasks,
} from "../src/repo/refinementRepo.js";
import { getStuckReasonsByProject } from "../src/repo/stuckRepo.js";
import { Graph } from "../src/domain/graph.js";
import { buildRefinementIssues } from "../src/domain/refinementIssues.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/**
 * Direct repository-level tests for the refinement aggregation/listing
 * queries: owner inheritance, the shared/unassigned bucket, done/cancelled
 * exclusion, owner/project filters, and that reassignment/project moves are
 * reflected without any extra bookkeeping (owner is always recomputed live
 * via `effectiveRepo`'s CTE, never cached).
 */
describe("refinementRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db);
  });

  describe("household clarification issues", () => {
    let handle: DbHandle;
    const today = "2026-08-25";

    beforeEach(() => {
      handle = openDb(":memory:");
      runMigrations(handle.db);
    });

    afterEach(() => {
      handle.close();
    });

    function issueCodes() {
      return buildRefinementIssues(Graph.load(handle.db), today).issues;
    }

    function addExternalWait(taskId: number, waitingFor = "External event") {
      handle.db.insert(schema.taskExternalWaits).values({ taskId, waitingFor }).run();
    }

    it("flags a legacy active project without a responsible person as urgent", () => {
      const project = createProject(handle.db, {
        title: "Legacy aktiv",
        status: "active",
      });
      const issue = issueCodes().find(
        (entry) =>
          entry.projectId === project.id && entry.code === "missing_driver",
      );
      expect(issue).toMatchObject({ severity: "urgent", entityType: "project" });
    });

    it("keeps backlog readiness separate from active refinement issues", () => {
      const project = createProject(handle.db, { title: "Später" });
      const result = buildRefinementIssues(Graph.load(handle.db), today);
      expect(
        result.issues.find(
          (entry) =>
            entry.projectId === project.id && entry.code === "missing_driver",
        ),
      ).toBeUndefined();
      expect(result.projects.find((entry) => entry.projectId === project.id)).toMatchObject({
        ready: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "missing_driver", severity: "info" }),
          expect.objectContaining({ code: "missing_outcome", severity: "info" }),
          expect.objectContaining({ code: "missing_next_action", severity: "info" }),
        ]),
      });
    });

    it("starts reporting missing active-work structure after backlog activation", () => {
      const owner = handle.db
        .insert(schema.members)
        .values({ name: "Mira", color: "#123456" })
        .returning()
        .get();
      const project = createProject(handle.db, {
        title: "Später ohne Plan",
        ownerMemberId: owner.id,
      });

      expect(
        issueCodes().some((entry) => entry.projectId === project.id),
      ).toBe(false);

      handle.db
        .update(schema.projects)
        .set({ status: "active" })
        .where(eq(schema.projects.id, project.id))
        .run();

      expect(
        issueCodes().filter(
          (entry) =>
            entry.projectId === project.id &&
            entry.code === "missing_next_action",
        ),
      ).toHaveLength(1);
    });

    it("flags a project with no executable next action", () => {
      const project = createProject(handle.db, {
        title: "Ohne nächsten Schritt",
        status: "active",
        ownerMemberId: handle.db
          .insert(schema.members)
          .values({ name: "Mira", color: "#123456" })
          .returning()
          .get().id,
      });
      expect(
        issueCodes().some(
          (entry) =>
            entry.projectId === project.id &&
            entry.code === "missing_next_action",
        ),
      ).toBe(true);
    });

    it("distinguishes missing, future, and due waiting follow-ups", () => {
      const missing = createTask(handle.db, {
        title: "Ohne Wiedervorlage",
        status: "actionable",
      });
      const future = createTask(handle.db, {
        title: "Später nachhaken",
        status: "actionable",
        scheduledDate: "2026-08-26",
      });
      const todayTask = createTask(handle.db, {
        title: "Heute nachhaken",
        status: "actionable",
        scheduledDate: today,
      });
      const past = createTask(handle.db, {
        title: "Gestern nachhaken",
        status: "actionable",
        scheduledDate: "2026-08-24",
      });
      for (const task of [missing, future, todayTask, past]) addExternalWait(task.id);
      const issues = issueCodes();
      expect(
        issues.find((entry) => entry.entityId === missing.id)?.code,
      ).toBe("waiting_without_followup");
      expect(
        issues.some(
          (entry) =>
            entry.entityId === future.id &&
            (entry.code === "waiting_without_followup" ||
              entry.code === "followup_due"),
        ),
      ).toBe(false);
      expect(
        issues.find((entry) => entry.entityId === todayTask.id)?.code,
      ).toBe("followup_due");
      expect(
        issues.find((entry) => entry.entityId === past.id)?.code,
      ).toBe("followup_due");
    });

    it("flags an open XL task without open children, but not completed/cancelled work", () => {
      const large = createTask(handle.db, {
        title: "Zu großer Block",
        status: "actionable",
        size: "XL",
      });
      const done = createTask(handle.db, {
        title: "Erledigt",
        status: "done",
        size: "XL",
        needsClarification: true,
      });
      const cancelled = createTask(handle.db, {
        title: "Verworfen",
        status: "cancelled",
        size: "XL",
        needsClarification: true,
      });
      const issues = issueCodes();
      expect(
        issues.some(
          (entry) =>
            entry.entityId === large.id &&
            entry.code === "too_large_without_children",
        ),
      ).toBe(true);
      expect(issues.some((entry) => entry.entityId === done.id)).toBe(false);
      expect(issues.some((entry) => entry.entityId === cancelled.id)).toBe(false);
    });

    it("does not turn tasks in backlog projects into clarification issues", () => {
      const project = createProject(handle.db, {
        title: "Vorbereitet für später",
        status: "backlog",
      });
      const captured = createTask(handle.db, {
        projectId: project.id,
        title: "Noch unklar",
        status: "captured",
      });
      const large = createTask(handle.db, {
        projectId: project.id,
        title: "Großer vorbereiteter Block",
        status: "actionable",
        size: "XL",
      });

      const issues = issueCodes();
      expect(issues.some((entry) => entry.entityId === captured.id)).toBe(false);
      expect(issues.some((entry) => entry.entityId === large.id)).toBe(false);
    });

    it("treats an actionable dependency sequence as an intentional clear path", () => {
      const owner = handle.db
        .insert(schema.members)
        .values({ name: "Mira", color: "#123456" })
        .returning()
        .get();
      const project = createProject(handle.db, {
        title: "Handwerker beauftragen",
        status: "active",
        ownerMemberId: owner.id,
      });
      const quote = createTask(handle.db, {
        projectId: project.id,
        title: "Angebot einholen",
      });
      const appointment = createTask(handle.db, {
        projectId: project.id,
        title: "Termin vereinbaren",
      });
      const pay = createTask(handle.db, {
        projectId: project.id,
        title: "Rechnung bezahlen",
      });
      addDependency(handle.db, appointment.id, quote.id);
      addDependency(handle.db, pay.id, appointment.id);

      const result = buildRefinementIssues(Graph.load(handle.db), today);
      expect(
        result.issues.some(
          (issue) =>
            (issue.entityId === appointment.id || issue.entityId === pay.id) &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toBe(false);
      expect(
        result.issues.some(
          (issue) =>
            issue.projectId === project.id &&
            issue.code === "missing_next_action",
        ),
      ).toBe(false);
    });

    it("flags a dependency branch that ends in waiting without a follow-up", () => {
      const waiting = createTask(handle.db, {
        title: "Auf Rückmeldung warten",
        status: "actionable",
      });
      addExternalWait(waiting.id, "Rückmeldung");
      const downstream = createTask(handle.db, {
        title: "Termin vereinbaren",
        status: "actionable",
      });
      addDependency(handle.db, downstream.id, waiting.id);

      const issues = issueCodes();
      expect(
        issues.find(
          (issue) =>
            issue.entityId === waiting.id &&
            issue.code === "waiting_without_followup",
        ),
      ).toBeDefined();
      expect(
        issues.find(
          (issue) =>
            issue.entityId === downstream.id &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toMatchObject({
        blockingReason: "waiting_without_followup",
        suggestedAction: {
          code: "set_followup",
          targetTaskId: waiting.id,
        },
      });
    });

    it("names and targets the captured prerequisite blocking a downstream task", () => {
      const prerequisite = createTask(handle.db, {
        title: "Schrank Lea konfigurieren",
        status: "captured",
      });
      const downstream = createTask(handle.db, {
        title: "Ikea: Kugellampe nachkaufen",
        status: "actionable",
      });
      addDependency(handle.db, downstream.id, prerequisite.id);

      const issue = buildRefinementIssues(Graph.load(handle.db), today).issues.find(
        (entry) =>
          entry.entityId === downstream.id &&
          entry.code === "blocked_without_clear_path",
      );

      expect(issue).toMatchObject({
        code: "blocked_without_clear_path",
        blockingReason: "captured",
        entityType: "task",
        entityId: downstream.id,
        entityTitle: "Ikea: Kugellampe nachkaufen",
        suggestedAction: {
          code: "clarify_task",
          targetTaskId: prerequisite.id,
        },
        dependencyPath: [
          { taskId: downstream.id, title: "Ikea: Kugellampe nachkaufen" },
          { taskId: prerequisite.id, title: "Schrank Lea konfigurieren" },
        ],
      });
      expect(issue).not.toHaveProperty("label");
      expect(issue).not.toHaveProperty("explanation");
      expect(issue?.suggestedAction).not.toHaveProperty("label");
    });

    it("targets the first problematic prerequisite through a multi-hop chain", () => {
      const captured = createTask(handle.db, {
        title: "Maße bestätigen",
        status: "captured",
      });
      const middle = createTask(handle.db, {
        title: "Schrank konfigurieren",
        status: "actionable",
      });
      const downstream = createTask(handle.db, {
        title: "Bestellung abschicken",
        status: "actionable",
      });
      addDependency(handle.db, middle.id, captured.id);
      addDependency(handle.db, downstream.id, middle.id);

      const issue = buildRefinementIssues(Graph.load(handle.db), today).issues.find(
        (entry) =>
          entry.entityId === downstream.id &&
          entry.code === "blocked_without_clear_path",
      );

      expect(issue?.suggestedAction.targetTaskId).toBe(captured.id);
      expect(issue?.dependencyPath?.map((entry) => entry.taskId)).toEqual([
        downstream.id,
        middle.id,
        captured.id,
      ]);
    });

    it("accepts a future waiting endpoint but flags a reached follow-up endpoint", () => {
      const future = createTask(handle.db, {
        title: "Geparkte Rückmeldung",
        status: "actionable",
        scheduledDate: "2026-08-26",
      });
      addExternalWait(future.id);
      const afterFuture = createTask(handle.db, {
        title: "Nach geparkter Rückmeldung",
        needsClarification: false,
      });
      addDependency(handle.db, afterFuture.id, future.id);

      const due = createTask(handle.db, {
        title: "Fällige Rückmeldung",
        status: "actionable",
        scheduledDate: today,
      });
      addExternalWait(due.id);
      const afterDue = createTask(handle.db, {
        title: "Nach fälliger Rückmeldung",
        needsClarification: false,
      });
      addDependency(handle.db, afterDue.id, due.id);

      const issues = issueCodes();
      expect(
        issues.some(
          (issue) =>
            issue.entityId === afterFuture.id &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toBe(false);
      expect(
        issues.some(
          (issue) =>
            issue.entityId === afterDue.id &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toBe(true);
      expect(
        issues.find(
          (issue) =>
            issue.entityId === afterDue.id &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toMatchObject({
        blockingReason: "followup_due",
        suggestedAction: {
          code: "follow_up",
          targetTaskId: due.id,
        },
      });
      expect(
        issues.some(
          (issue) =>
            issue.entityId === due.id && issue.code === "followup_due",
        ),
      ).toBe(true);
    });

    it("does not report a missing next action for an intentional parked chain", () => {
      const owner = handle.db
        .insert(schema.members)
        .values({ name: "Theo", color: "#654321" })
        .returning()
        .get();
      const project = createProject(handle.db, {
        title: "Auf Rückmeldung warten",
        status: "active",
        ownerMemberId: owner.id,
      });
      const waiting = createTask(handle.db, {
        projectId: project.id,
        title: "Angebot kommt",
        status: "actionable",
        scheduledDate: "2026-08-26",
      });
      addExternalWait(waiting.id);
      const downstream = createTask(handle.db, {
        projectId: project.id,
        title: "Termin vereinbaren",
      });
      addDependency(handle.db, downstream.id, waiting.id);

      expect(
        issueCodes().some(
          (issue) =>
            issue.projectId === project.id &&
            issue.code === "missing_next_action",
        ),
      ).toBe(false);
    });

    it("flags a dependency endpoint hidden in a completed project", () => {
      const completedProject = createProject(handle.db, {
        title: "Schon abgeschlossen",
        status: "completed",
      });
      const hiddenAction = createTask(handle.db, {
        projectId: completedProject.id,
        title: "Doch noch offen",
      });
      const downstream = createTask(handle.db, {
        title: "Kann sonst nicht weiter",
        needsClarification: false,
      });
      addDependency(handle.db, downstream.id, hiddenAction.id);

      expect(
        issueCodes().some(
          (issue) =>
            issue.entityId === downstream.id &&
            issue.code === "blocked_without_clear_path",
        ),
      ).toBe(true);
    });

    it("does not treat a dependency in a backlog project as an executable path", () => {
      const owner = handle.db
        .insert(schema.members)
        .values({ name: "Mira", color: "#123456" })
        .returning()
        .get();
      const activeProject = createProject(handle.db, {
        title: "Aktive Arbeit",
        status: "active",
        ownerMemberId: owner.id,
      });
      const backlogProject = createProject(handle.db, {
        title: "Später",
        status: "backlog",
      });
      const backlogDependency = createTask(handle.db, {
        projectId: backlogProject.id,
        title: "Noch nicht gestartete Voraussetzung",
      });
      const downstream = createTask(handle.db, {
        projectId: activeProject.id,
        title: "Aktiver nächster Schritt",
      });
      addDependency(handle.db, downstream.id, backlogDependency.id);

      const issue = issueCodes().find(
        (entry) =>
          entry.entityId === downstream.id &&
          entry.code === "blocked_without_clear_path",
      );
      expect(issue).toMatchObject({
        blockingReason: "backlog_project",
        suggestedAction: {
          code: "resolve_blocker",
          targetTaskId: backlogDependency.id,
        },
      });
      expect(getStuckReasonsByProject(handle.db, today).get(activeProject.id)).toBe(
        "blocked_without_clear_path",
      );
    });
  });

  afterEach(() => {
    handle.close();
  });

  function createMember(name: string) {
    return handle.db
      .insert(schema.members)
      .values({ name, color: "#123456" })
      .returning()
      .get();
  }

  function countsFor(ownerId: number | null, rows: ReturnType<typeof getRefinementOwnerSizeCounts>) {
    return rows.find((r) => r.ownerId === ownerId)!;
  }

  it("aggregates open tasks by effective owner (project-inherited and parent-inherited) and size", () => {
    const owner = createMember("Projektinhaberin");
    const project = createProject(handle.db, {
      title: "Projekt",
      status: "active",
      ownerMemberId: owner.id,
    });
    const root = createTask(handle.db, {
      projectId: project.id,
      title: "Wurzel",
      size: "M",
      status: "actionable",
    });
    createTask(handle.db, {
      parentTaskId: root.id,
      title: "Kind",
      size: "S",
      status: "actionable",
    });
    createTask(handle.db, {
      projectId: project.id,
      title: "Ohne Größe",
      status: "actionable",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const ownerCounts = countsFor(owner.id, counts);
    expect(ownerCounts.S).toBe(1);
    expect(ownerCounts.M).toBe(1);
    expect(ownerCounts.unestimated).toBe(1);
    expect(ownerCounts.total).toBe(3);
  });

  it("groups tasks with no effective owner (including opted-out) under the shared/null bucket", () => {
    createTask(handle.db, { title: "Ohne Zuständigkeit", size: "L", status: "actionable" });
    const owner = createMember("Jemand");
    const projectOwned = createProject(handle.db, {
      title: "Projekt",
      status: "active",
      ownerMemberId: owner.id,
    });
    createTask(handle.db, {
      projectId: projectOwned.id,
      title: "Explizit ohne",
      size: "XL",
      status: "actionable",
      ownerInheritanceMode: "none",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const shared = countsFor(null, counts);
    expect(shared.L).toBe(1);
    expect(shared.XL).toBe(1);
    expect(shared.total).toBe(2);
    // The owned project's own count stays unaffected by the opted-out task.
    expect(countsFor(owner.id, counts).total).toBe(0);
  });

  it("excludes done and cancelled tasks from both owner counts and task rows", () => {
    const owner = createMember("Erledigerin");
    const done = createTask(handle.db, {
      title: "Fertig",
      size: "S",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    updateTask(handle.db, done.id, { status: "done" });
    const cancelled = createTask(handle.db, {
      title: "Verworfen",
      size: "M",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });
    updateTask(handle.db, cancelled.id, { status: "cancelled" });
    createTask(handle.db, {
      title: "Offen",
      size: "L",
      status: "actionable",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });

    const counts = getRefinementOwnerSizeCounts(handle.db);
    const ownerCounts = countsFor(owner.id, counts);
    expect(ownerCounts.total).toBe(1);
    expect(ownerCounts.L).toBe(1);

    const rows = getRefinementTasks(handle.db);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(cancelled.id);
  });

  it("includes standalone and active-project work but excludes backlog and terminal project tasks", () => {
    const active = createProject(handle.db, {
      title: "Aktiv",
      status: "active",
    });
    const backlog = createProject(handle.db, {
      title: "Später",
      status: "backlog",
    });
    const completed = createProject(handle.db, {
      title: "Fertig",
      status: "completed",
    });
    const activeTask = createTask(handle.db, {
      projectId: active.id,
      title: "Aktive Projektaufgabe",
      size: "S",
    });
    const standalone = createTask(handle.db, {
      title: "Eigenständige Aufgabe",
      status: "someday",
      size: "M",
    });
    const backlogTask = createTask(handle.db, {
      projectId: backlog.id,
      title: "Vorbereitete Backlog-Aufgabe",
      size: "L",
    });
    const completedTask = createTask(handle.db, {
      projectId: completed.id,
      title: "Offen in fertigem Projekt",
      size: "XL",
    });

    const ids = getRefinementTasks(handle.db).map((row) => row.id);
    expect(ids).toContain(activeTask.id);
    expect(ids).toContain(standalone.id);
    expect(ids).not.toContain(backlogTask.id);
    expect(ids).not.toContain(completedTask.id);

    const shared = countsFor(null, getRefinementOwnerSizeCounts(handle.db));
    expect(shared).toMatchObject({ S: 1, M: 1, L: 0, XL: 0, total: 2 });
  });

  it("returns self-contained blocker rows with transitive attention dates", () => {
    const external = createTask(handle.db, {
      title: "Lieferung abwarten",
      status: "actionable",
      scheduledDate: "2026-09-02",
    });
    handle.db
      .insert(schema.taskExternalWaits)
      .values({ taskId: external.id, waitingFor: "Spedition" })
      .run();
    const middle = createTask(handle.db, {
      title: "Montage vorbereiten",
      status: "actionable",
    });
    const downstream = createTask(handle.db, {
      title: "Schrank montieren",
      status: "actionable",
    });
    addDependency(handle.db, middle.id, external.id);
    addDependency(handle.db, downstream.id, middle.id);

    const row = getRefinementTasks(handle.db).find((entry) => entry.id === downstream.id);
    expect(row).toMatchObject({
      id: downstream.id,
      title: "Schrank montieren",
      blocked: true,
      executable: false,
      externalWait: null,
      nextBlockerAttentionDate: "2026-09-02",
      dependencies: [
        expect.objectContaining({
          dependsOnTaskId: middle.id,
          title: "Montage vorbereiten",
          resolved: false,
        }),
      ],
      blockers: [
        expect.objectContaining({
          type: "dependency",
          taskId: middle.id,
          title: "Montage vorbereiten",
        }),
      ],
    });
    expect(row).toHaveProperty("effectiveTags");
    expect(row).toHaveProperty("effectiveOwnerSource");
  });

  it("keeps unestimated tasks in the effort view without creating an estimate issue", () => {
    const task = createTask(handle.db, {
      title: "Noch ohne Aufwand",
      status: "actionable",
    });

    expect(getRefinementTasks(handle.db).map((row) => row.id)).toContain(task.id);
    expect(countsFor(null, getRefinementOwnerSizeCounts(handle.db)).unestimated).toBe(1);
    expect(
      buildRefinementIssues(Graph.load(handle.db)).issues.some(
        (issue) => issue.entityId === task.id && issue.code.includes("estimate"),
      ),
    ).toBe(false);
  });

  it("filters task rows and counts by ownerId (including the 'none'/shared bucket) and by projectId", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const projectA = createProject(handle.db, {
      title: "A",
      status: "active",
      ownerMemberId: alice.id,
    });
    const projectB = createProject(handle.db, {
      title: "B",
      status: "active",
      ownerMemberId: bob.id,
    });
    const taskA = createTask(handle.db, {
      projectId: projectA.id,
      title: "A-Aufgabe",
      status: "actionable",
      size: "S",
    });
    createTask(handle.db, {
      projectId: projectB.id,
      title: "B-Aufgabe",
      status: "actionable",
      size: "M",
    });
    const sharedTask = createTask(handle.db, {
      title: "Geteilt",
      status: "actionable",
      size: "L",
    });

    const aliceRows = getRefinementTasks(handle.db, { ownerId: alice.id });
    expect(aliceRows.map((r) => r.id)).toEqual([taskA.id]);

    const projectARows = getRefinementTasks(handle.db, { projectId: projectA.id });
    expect(projectARows.map((r) => r.id)).toEqual([taskA.id]);

    const sharedRows = getRefinementTasks(handle.db, { ownerId: null });
    expect(sharedRows.map((r) => r.id)).toEqual([sharedTask.id]);

    const aliceCounts = getRefinementOwnerSizeCounts(handle.db, { ownerId: alice.id });
    expect(countsFor(alice.id, aliceCounts).total).toBe(1);
    expect(countsFor(bob.id, aliceCounts).total).toBe(0);
    expect(countsFor(null, aliceCounts).total).toBe(0);
  });

  it("reflects reassignment: a task's owner bucket changes immediately after updateTask", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const task = createTask(handle.db, {
      title: "Wechselnd",
      status: "actionable",
      size: "M",
      ownerMemberId: alice.id,
      ownerInheritanceMode: "explicit",
    });

    let counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(1);
    expect(countsFor(bob.id, counts).total).toBe(0);

    updateTask(handle.db, task.id, { ownerMemberId: bob.id });

    counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(0);
    expect(countsFor(bob.id, counts).total).toBe(1);

    const rows = getRefinementTasks(handle.db);
    const row = rows.find((r) => r.id === task.id)!;
    expect(row.effectiveOwnerId).toBe(bob.id);
  });

  it("reflects project moves: moving a task to a project with a different owner updates its effective owner and project filter results", () => {
    const alice = createMember("Alice");
    const bob = createMember("Bob");
    const projectA = createProject(handle.db, {
      title: "A",
      status: "active",
      ownerMemberId: alice.id,
    });
    const projectB = createProject(handle.db, {
      title: "B",
      status: "active",
      ownerMemberId: bob.id,
    });
    const task = createTask(handle.db, {
      projectId: projectA.id,
      title: "Wandert",
      status: "actionable",
      size: "S",
    });

    expect(getRefinementTasks(handle.db, { projectId: projectA.id }).map((r) => r.id)).toEqual([
      task.id,
    ]);
    expect(countsFor(alice.id, getRefinementOwnerSizeCounts(handle.db)).total).toBe(1);

    moveTask(handle.db, task.id, {
      parentTaskId: null,
      projectId: projectB.id,
      expectedRevision: task.revision,
    });

    expect(getRefinementTasks(handle.db, { projectId: projectA.id })).toEqual([]);
    expect(getRefinementTasks(handle.db, { projectId: projectB.id }).map((r) => r.id)).toEqual([
      task.id,
    ]);
    const counts = getRefinementOwnerSizeCounts(handle.db);
    expect(countsFor(alice.id, counts).total).toBe(0);
    expect(countsFor(bob.id, counts).total).toBe(1);
  });

  it("always includes every member plus a trailing shared row, even with all-zero counts", () => {
    const alice = createMember("Alice");
    const counts = getRefinementOwnerSizeCounts(handle.db);
    expect(counts).toHaveLength(2);
    expect(counts[0]).toMatchObject({ ownerId: alice.id, total: 0, S: 0, M: 0, L: 0, XL: 0, unestimated: 0 });
    expect(counts[1]).toMatchObject({ ownerId: null, total: 0 });
  });
});

/**
 * HTTP-level tests for the `/api/refinement/*` routes and the task
 * create/update `size` plumbing that backs the refinement UI's size-cycle
 * interactions.
 */
describe("refinement API routes", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function post(url: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "POST", url, payload });
  }

  async function patch(url: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "PATCH", url, payload });
  }

  it("creates a task with a size and returns 400 for an invalid size", async () => {
    const created = await post("/api/tasks", { title: "Größere Aufgabe", size: "L" });
    expect(created.statusCode).toBe(201);

    const invalid = await post("/api/tasks", { title: "Ungültig", size: "XXL" });
    expect(invalid.statusCode).toBe(400);
  });

  it("updates a task's size, including clearing it back to null", async () => {
    const created = (await post("/api/tasks", { title: "Aufgabe" })).json();

    const withSize = await patch(`/api/tasks/${created.id}`, { size: "XL" });
    expect(withSize.statusCode).toBe(200);

    const cleared = await patch(`/api/tasks/${created.id}`, { size: null });
    expect(cleared.statusCode).toBe(200);
  });

  it("GET /api/refinement/owners returns the owner x size matrix with a shared row", async () => {
    const memberRes = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Refinement-Mitglied" },
    });
    const member = memberRes.json();
    await post("/api/tasks", {
      title: "Zugeordnet",
      size: "S",
      status: "actionable",
      ownerMemberId: member.id,
      ownerInheritanceMode: "explicit",
    });
    await post("/api/tasks", { title: "Geteilt", size: "M", status: "actionable" });

    const res = await ctx.app.inject({ method: "GET", url: "/api/refinement/owners" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ ownerId: number | null; S: number; M: number; total: number }>;
    const ownerRow = body.find((r) => r.ownerId === member.id)!;
    expect(ownerRow.S).toBe(1);
    const sharedRow = body.find((r) => r.ownerId === null)!;
    expect(sharedRow.M).toBe(1);
  });

  it("GET /api/refinement/tasks supports ownerId=none and projectId filters, and rejects unknown owners", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Refinement-Projekt", status: "active" },
    });
    const project = projectRes.json();
    await post("/api/tasks", {
      title: "Im Projekt",
      projectId: project.id,
      status: "actionable",
      size: "S",
    });
    await post("/api/tasks", { title: "Geteilt", status: "actionable", size: "M" });

    const sharedRes = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks?ownerId=none",
    });
    expect(sharedRes.statusCode).toBe(200);
    expect(sharedRes.json()).toHaveLength(2);

    const projectRowsRes = await ctx.app.inject({
      method: "GET",
      url: `/api/refinement/tasks?projectId=${project.id}`,
    });
    expect(projectRowsRes.json()).toHaveLength(1);

    const unknownOwnerRes = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks?ownerId=999999",
    });
    expect(unknownOwnerRes.statusCode).toBe(404);
  });

  it("excludes done/cancelled tasks from /api/refinement/tasks", async () => {
    const created = await post("/api/tasks", { title: "Wird erledigt", status: "actionable" });
    const task = created.json();
    await ctx.app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete`, payload: {} });

    const res = await ctx.app.inject({ method: "GET", url: "/api/refinement/tasks" });
    expect(res.json().map((r: { id: number }) => r.id)).not.toContain(task.id);
  });

  it("keeps captured open work available for refinement", async () => {
    const created = await post("/api/tasks", {
      title: "Noch zu klären",
      status: "actionable",
      needsClarification: true,
      size: "M",
    });
    const task = created.json();

    const tasks = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/tasks",
    });
    expect(tasks.json().map((row: { id: number }) => row.id)).toContain(task.id);

    const owners = await ctx.app.inject({
      method: "GET",
      url: "/api/refinement/owners",
    });
    const shared = (
      owners.json() as Array<{ ownerId: number | null; M: number }>
    ).find((row) => row.ownerId === null);
    expect(shared?.M).toBe(1);
  });
});

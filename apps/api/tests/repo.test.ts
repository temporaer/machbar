import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import {
  addDependency,
  createProject,
  createTask,
  getOrCreateTag,
  moveSubtreeToProject,
  moveTask,
  updateTask,
} from "../src/domain/mutations.js";
import {
  getBlockedTaskIds,
  wouldCreateDependencyCycle,
} from "../src/repo/dependencyRepo.js";
import {
  getEffectiveOwnersAndContexts,
  getEffectiveTagIds,
} from "../src/repo/effectiveRepo.js";
import { getNextActionTaskIdsByProject } from "../src/repo/nextActionRepo.js";
import { getStuckReasonsByProject } from "../src/repo/stuckRepo.js";
import {
  getAncestorIds,
  getDescendantIds,
  wouldCreateHierarchyCycle,
} from "../src/repo/treeRepo.js";

/**
 * Direct, isolated unit tests for the SQL/CTE-backed repository layer
 * (`src/repo/*`), exercised through the mutation/service functions that
 * build fixtures on a fresh in-memory database — no HTTP layer involved.
 * These complement the end-to-end route tests by pinning down the exact
 * semantics of each repository query in isolation.
 */
describe("repository layer (SQL/CTE-backed queries)", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db);
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

  describe("descendants and ancestors", () => {
    it("returns every descendant at arbitrary depth, excluding unrelated tasks", () => {
      const root = createTask(handle.db, { title: "Wurzel" });
      const child = createTask(handle.db, { title: "Kind", parentTaskId: root.id });
      const grandchild = createTask(handle.db, {
        title: "Enkelkind",
        parentTaskId: child.id,
      });
      const greatGrandchild = createTask(handle.db, {
        title: "Urenkelkind",
        parentTaskId: grandchild.id,
      });
      const unrelated = createTask(handle.db, { title: "Unabhängig" });

      const descendants = getDescendantIds(handle.db, root.id).sort((a, b) => a - b);
      expect(descendants).toEqual(
        [child.id, grandchild.id, greatGrandchild.id].sort((a, b) => a - b),
      );
      expect(descendants).not.toContain(unrelated.id);
      expect(getDescendantIds(handle.db, greatGrandchild.id)).toEqual([]);
    });

    it("returns ancestors nearest-first up to the root", () => {
      const root = createTask(handle.db, { title: "Wurzel" });
      const child = createTask(handle.db, { title: "Kind", parentTaskId: root.id });
      const grandchild = createTask(handle.db, {
        title: "Enkelkind",
        parentTaskId: child.id,
      });

      expect(getAncestorIds(handle.db, grandchild.id)).toEqual([child.id, root.id]);
      expect(getAncestorIds(handle.db, root.id)).toEqual([]);
    });

    it("detects hierarchy cycles: self-parenting and re-parenting under a descendant", () => {
      const root = createTask(handle.db, { title: "Wurzel" });
      const child = createTask(handle.db, { title: "Kind", parentTaskId: root.id });
      const grandchild = createTask(handle.db, {
        title: "Enkelkind",
        parentTaskId: child.id,
      });
      const unrelated = createTask(handle.db, { title: "Unabhängig" });

      expect(wouldCreateHierarchyCycle(handle.db, root.id, root.id)).toBe(true);
      expect(wouldCreateHierarchyCycle(handle.db, root.id, grandchild.id)).toBe(true);
      expect(wouldCreateHierarchyCycle(handle.db, root.id, unrelated.id)).toBe(false);
    });
  });

  describe("effective owner/context/tags", () => {
    it("computes owner/context inheritance for every task in one pass and labels the source correctly", () => {
      const projectOwner = createMember("Projektinhaberin");
      const parentOwner = createMember("Elternzuständiger");
      const project = createProject(handle.db, {
        title: "Projekt",
        ownerMemberId: projectOwner.id,
        context: "Zuhause",
      });
      const root = createTask(handle.db, { projectId: project.id, title: "Wurzel" });
      const explicitParent = updateTask(handle.db, root.id, {
        ownerMemberId: parentOwner.id,
        ownerInheritanceMode: "explicit",
        context: "Büro",
        contextInheritanceMode: "explicit",
      });
      const child = createTask(handle.db, {
        parentTaskId: explicitParent.id,
        title: "Kind",
      });
      const grandchild = createTask(handle.db, { parentTaskId: child.id, title: "Enkelkind" });
      const optedOut = createTask(handle.db, {
        parentTaskId: grandchild.id,
        title: "Ohne Zuständigkeit",
        ownerInheritanceMode: "none",
        contextInheritanceMode: "none",
      });

      const effective = getEffectiveOwnersAndContexts(handle.db);
      expect(effective.get(explicitParent.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "task",
        context: "Büro",
        contextSource: "task",
      });
      expect(effective.get(child.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "parent",
        context: "Büro",
        contextSource: "parent",
      });
      expect(effective.get(grandchild.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "parent",
        context: "Büro",
        contextSource: "parent",
      });
      expect(effective.get(optedOut.id)).toMatchObject({
        ownerId: null,
        ownerSource: "none",
        context: null,
        contextSource: "none",
      });
    });

    it("folds project tags, per-task exclusions and explicit additions down the chain", () => {
      const tagProject = getOrCreateTag(handle.db, "Projekt-Tag");
      const tagRoot = getOrCreateTag(handle.db, "Wurzel-Tag");
      const tagLeaf = getOrCreateTag(handle.db, "Blatt-Tag");
      const project = createProject(handle.db, {
        title: "Projekt mit Tags",
        tagIds: [tagProject.id],
      });
      const root = createTask(handle.db, {
        projectId: project.id,
        title: "Wurzel",
        tagIds: [tagRoot.id],
      });
      const child = createTask(handle.db, { parentTaskId: root.id, title: "Kind" });
      const grandchildRaw = createTask(handle.db, {
        parentTaskId: child.id,
        title: "Enkelkind",
      });
      // The grandchild excludes the root's tag but adds its own explicit tag.
      const grandchild = updateTask(handle.db, grandchildRaw.id, {
        tagIds: [tagLeaf.id],
        excludedTagIds: [tagRoot.id],
      });

      const effectiveTags = getEffectiveTagIds(handle.db);
      expect(new Set(effectiveTags.get(root.id))).toEqual(
        new Set([tagProject.id, tagRoot.id]),
      );
      expect(new Set(effectiveTags.get(child.id))).toEqual(
        new Set([tagProject.id, tagRoot.id]),
      );
      expect(new Set(effectiveTags.get(grandchild.id))).toEqual(
        new Set([tagProject.id, tagLeaf.id]),
      );
    });
  });

  describe("blocked-state derivation", () => {
    it("flags a task blocked while its dependency is open, and clears it once resolved", () => {
      const blocker = createTask(handle.db, { title: "Blockierend", status: "actionable" });
      const dependent = createTask(handle.db, { title: "Abhängig", status: "actionable" });
      addDependency(handle.db, dependent.id, blocker.id);

      expect(getBlockedTaskIds(handle.db).has(dependent.id)).toBe(true);

      updateTask(handle.db, blocker.id, { status: "done" });
      expect(getBlockedTaskIds(handle.db).has(dependent.id)).toBe(false);
    });

    it("detects direct and transitive dependency cycles but allows valid new edges", () => {
      const a = createTask(handle.db, { title: "A" });
      const b = createTask(handle.db, { title: "B" });
      const c = createTask(handle.db, { title: "C" });
      addDependency(handle.db, a.id, b.id); // A depends on B
      addDependency(handle.db, b.id, c.id); // B depends on C

      expect(wouldCreateDependencyCycle(handle.db, a.id, a.id)).toBe(true);
      // C -> A would close the loop A -> B -> C -> A.
      expect(wouldCreateDependencyCycle(handle.db, c.id, a.id)).toBe(true);

      const d = createTask(handle.db, { title: "D" });
      expect(wouldCreateDependencyCycle(handle.db, d.id, a.id)).toBe(false);
    });
  });

  describe("next-action selection", () => {
    it("picks the first actionable, unblocked task in depth-first pre-order", () => {
      const project = createProject(handle.db, { title: "Projekt" });
      const root = createTask(handle.db, {
        projectId: project.id,
        title: "Wurzel",
        status: "actionable",
      });
      const blocker = createTask(handle.db, {
        projectId: project.id,
        title: "Blockierer",
        status: "waiting",
      });
      addDependency(handle.db, root.id, blocker.id); // root blocked until blocker resolves
      const rootChild = createTask(handle.db, {
        parentTaskId: root.id,
        title: "Kind der Wurzel",
        status: "actionable",
      });
      createTask(handle.db, {
        projectId: project.id,
        title: "Zweite Wurzel",
        status: "actionable",
      });

      // root is blocked, so pre-order should skip straight to its own
      // (unblocked) child before reaching the later top-level sibling.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)).toBe(rootChild.id);

      updateTask(handle.db, blocker.id, { status: "done" });
      // Once unblocked, root itself comes first in pre-order.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)).toBe(root.id);
    });

    it("omits a project with no actionable candidates from the result map", () => {
      const project = createProject(handle.db, { title: "Nur Warten" });
      createTask(handle.db, { projectId: project.id, title: "Wartet", status: "waiting" });
      expect(getNextActionTaskIdsByProject(handle.db).has(project.id)).toBe(false);
    });

    it("skips captured candidates while preserving descendant order and effective blocking", () => {
      const project = createProject(handle.db, { title: "Gemischter Baum" });
      const capturedRoot = createTask(handle.db, {
        projectId: project.id,
        title: "Erfasste Wurzel",
        status: "actionable",
      });
      const blockedChild = createTask(handle.db, {
        parentTaskId: capturedRoot.id,
        title: "Geklärtes, blockiertes Kind",
        status: "actionable",
      });
      const capturedBlocker = createTask(handle.db, {
        parentTaskId: capturedRoot.id,
        title: "Erfasster Blockierer",
        status: "actionable",
      });
      addDependency(handle.db, blockedChild.id, capturedBlocker.id);
      const laterChild = createTask(handle.db, {
        parentTaskId: capturedRoot.id,
        title: "Späteres geklärtes Kind",
        status: "actionable",
      });
      handle.sqlite
        .prepare("UPDATE tasks SET needs_clarification = 1 WHERE id IN (?, ?)")
        .run(capturedRoot.id, capturedBlocker.id);

      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)).toBe(
        laterChild.id,
      );
    });
  });

  describe("stuck-project classification", () => {
    it("classifies unassigned_actionable, only_waiting, no_next_action, blocked_dependencies and healthy projects", () => {
      const owner = createMember("Zuständige Person");

      const unassigned = createProject(handle.db, {
        title: "Unzugewiesen",
        status: "active",
      });
      createTask(handle.db, {
        projectId: unassigned.id,
        title: "Offen",
        status: "actionable",
      });

      const onlyWaiting = createProject(handle.db, {
        title: "Nur Warten",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: onlyWaiting.id,
        title: "Wartet",
        status: "waiting",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const noNextAction = createProject(handle.db, {
        title: "Kein Nächstes",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: noNextAction.id,
        title: "Irgendwann",
        status: "someday",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const blockedProject = createProject(handle.db, {
        title: "Blockiert",
        status: "active",
        ownerMemberId: owner.id,
      });
      const blockerTask = createTask(handle.db, {
        projectId: blockedProject.id,
        title: "Blockierer",
        status: "waiting",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      const blockedTask = createTask(handle.db, {
        projectId: blockedProject.id,
        title: "Blockiert",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addDependency(handle.db, blockedTask.id, blockerTask.id);

      const healthy = createProject(handle.db, {
        title: "Gesund",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: healthy.id,
        title: "Machbar",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(unassigned.id)).toBe("unassigned_actionable");
      expect(reasons.get(onlyWaiting.id)).toBe("only_waiting_without_followup");
      expect(reasons.get(noNextAction.id)).toBe("no_next_action");
      expect(reasons.get(blockedProject.id)).toBe("blocked_dependencies");
      expect(reasons.has(healthy.id)).toBe(false);
    });

    it("flags an active project with zero tasks as no_next_action", () => {
      const empty = createProject(handle.db, { title: "Leer", status: "active" });
      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(empty.id)).toBe("no_next_action");
    });

    it("counts captured tasks as open but not actionable, including mixed inherited descendants", () => {
      const owner = createMember("Projektzuständige");
      const capturedOnly = createProject(handle.db, {
        title: "Nur erfasst",
        status: "active",
        ownerMemberId: owner.id,
      });
      const capturedRoot = createTask(handle.db, {
        projectId: capturedOnly.id,
        title: "Erfasste Wurzel",
        status: "actionable",
        ownerInheritanceMode: "none",
      });
      const capturedWaiting = createTask(handle.db, {
        parentTaskId: capturedRoot.id,
        title: "Erfasstes wartendes Kind",
        status: "waiting",
      });
      handle.sqlite
        .prepare("UPDATE tasks SET needs_clarification = 1 WHERE id IN (?, ?)")
        .run(capturedRoot.id, capturedWaiting.id);

      const mixed = createProject(handle.db, {
        title: "Erfasst plus geklärt",
        status: "active",
        ownerMemberId: owner.id,
      });
      const mixedRoot = createTask(handle.db, {
        projectId: mixed.id,
        title: "Erfasster unzugewiesener Elternknoten",
        status: "actionable",
        ownerInheritanceMode: "none",
      });
      createTask(handle.db, {
        parentTaskId: mixedRoot.id,
        title: "Geklärtes Kind mit Projektzuständigkeit",
        status: "actionable",
        ownerInheritanceMode: "explicit",
        ownerMemberId: owner.id,
      });
      handle.sqlite
        .prepare("UPDATE tasks SET needs_clarification = 1 WHERE id = ?")
        .run(mixedRoot.id);

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(capturedOnly.id)).toBe("no_next_action");
      expect(reasons.has(mixed.id)).toBe(false);
    });

    it("keeps all-future waiting work parked, but flags a mixed missing Wiedervorlage", () => {
      const owner = createMember("Wiedervorlage-Zuständige");

      const withRevisit = createProject(handle.db, {
        title: "Warten mit Wiedervorlage",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: withRevisit.id,
        title: "Wartet mit Termin",
        status: "waiting",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      createTask(handle.db, {
        projectId: withRevisit.id,
        title: "Wartet ohne Termin",
        status: "waiting",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const reasons = getStuckReasonsByProject(handle.db, "2026-08-25");
      expect(reasons.get(withRevisit.id)).toBe("only_waiting_without_followup");
    });

    it("treats future revisits as parked and today/past revisits as due", () => {
      const owner = createMember("Termin-Zuständige");
      const today = new Date().toISOString().slice(0, 10);

      const projectIds = ["2020-01-01", today, "2099-12-31"].map((scheduledDate) => {
        const project = createProject(handle.db, {
          title: `Warten bis ${scheduledDate}`,
          status: "active",
          ownerMemberId: owner.id,
        });
        createTask(handle.db, {
          projectId: project.id,
          title: "Wartet",
          status: "waiting",
          scheduledDate,
          ownerMemberId: owner.id,
          ownerInheritanceMode: "explicit",
        });
        return project.id;
      });

      const reasons = getStuckReasonsByProject(handle.db, today);
      expect(reasons.get(projectIds[0]!)).toBe("followup_due");
      expect(reasons.get(projectIds[1]!)).toBe("followup_due");
      expect(reasons.has(projectIds[2]!)).toBe(false);
    });

    it("still flags only_waiting when the revisit date is missing or blank", () => {
      const owner = createMember("Ohne-Termin-Zuständige");

      const nullDate = createProject(handle.db, {
        title: "Warten ohne Termin",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: nullDate.id,
        title: "Wartet",
        status: "waiting",
        scheduledDate: null,
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const blankDate = createProject(handle.db, {
        title: "Warten mit leerem Termin",
        status: "active",
        ownerMemberId: owner.id,
      });
      const blankTask = createTask(handle.db, {
        projectId: blankDate.id,
        title: "Wartet",
        status: "waiting",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      handle.db
        .update(schema.tasks)
        .set({ scheduledDate: "   " })
        .where(eq(schema.tasks.id, blankTask.id))
        .run();

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(nullDate.id)).toBe("only_waiting_without_followup");
      expect(reasons.get(blankDate.id)).toBe("only_waiting_without_followup");
    });

    it("does not let a scheduled revisit mask other stuck reasons", () => {
      const owner = createMember("Vorrang-Zuständige");

      // Not every open task is waiting: a `someday` task keeps the project
      // stuck for lack of a next action.
      const mixedSomeday = createProject(handle.db, {
        title: "Warten und Irgendwann",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: mixedSomeday.id,
        title: "Wartet mit Termin",
        status: "waiting",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      createTask(handle.db, {
        projectId: mixedSomeday.id,
        title: "Irgendwann",
        status: "someday",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      // An unassigned actionable task keeps its higher-priority reason.
      const mixedUnassigned = createProject(handle.db, {
        title: "Warten und Unzugewiesen",
        status: "active",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: mixedUnassigned.id,
        title: "Wartet mit Termin",
        status: "waiting",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      createTask(handle.db, {
        projectId: mixedUnassigned.id,
        title: "Offen ohne Zuständige",
        status: "actionable",
        ownerInheritanceMode: "none",
      });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(mixedSomeday.id)).toBe("no_next_action");
      expect(reasons.get(mixedUnassigned.id)).toBe("unassigned_actionable");
    });

    it("parks actionable work blocked directly or transitively only by scheduled waiting tasks", () => {
      const owner = createMember("Geplant blockiert");
      const project = createProject(handle.db, {
        title: "Geplant geparkt",
        status: "active",
        ownerMemberId: owner.id,
      });
      const scheduled = createTask(handle.db, {
        projectId: project.id,
        title: "Terminierter Blockierer",
        status: "waiting",
        scheduledDate: "2026-10-15",
      });
      const intermediate = createTask(handle.db, {
        projectId: project.id,
        title: "Zwischenschritt",
        status: "actionable",
      });
      const direct = createTask(handle.db, {
        projectId: project.id,
        title: "Direkt blockiert",
        status: "actionable",
      });
      const transitive = createTask(handle.db, {
        projectId: project.id,
        title: "Transitiv blockiert",
        status: "actionable",
      });
      addDependency(handle.db, intermediate.id, scheduled.id);
      addDependency(handle.db, direct.id, scheduled.id);
      addDependency(handle.db, transitive.id, intermediate.id);

      expect(getStuckReasonsByProject(handle.db).has(project.id)).toBe(false);
    });

    it("does not park mixed, unscheduled, captured, or unassigned blocked work", () => {
      const owner = createMember("Nicht geparkt");
      const makeProject = (title: string) =>
        createProject(handle.db, { title, status: "active", ownerMemberId: owner.id });
      const makeAction = (projectId: number, title: string) =>
        createTask(handle.db, { projectId, title, status: "actionable" });

      const unscheduledProject = makeProject("Unterminierter Blockierer");
      const unscheduled = createTask(handle.db, {
        projectId: unscheduledProject.id,
        title: "Warten ohne Termin",
        status: "waiting",
      });
      const unscheduledAction = makeAction(unscheduledProject.id, "Blockiert");
      addDependency(handle.db, unscheduledAction.id, unscheduled.id);

      const capturedProject = makeProject("Erfasster Blockierer");
      const captured = createTask(handle.db, {
        projectId: capturedProject.id,
        title: "Erfasst und terminiert",
        status: "waiting",
        scheduledDate: "2026-10-15",
      });
      handle.db
        .update(schema.tasks)
        .set({ needsClarification: true })
        .where(eq(schema.tasks.id, captured.id))
        .run();
      const capturedAction = makeAction(capturedProject.id, "Blockiert");
      addDependency(handle.db, capturedAction.id, captured.id);

      const mixedProject = makeProject("Unabhängige offene Arbeit");
      const scheduled = createTask(handle.db, {
        projectId: mixedProject.id,
        title: "Terminiert",
        status: "waiting",
        scheduledDate: "2026-10-15",
      });
      const mixedAction = makeAction(mixedProject.id, "Blockiert");
      addDependency(handle.db, mixedAction.id, scheduled.id);
      createTask(handle.db, {
        projectId: mixedProject.id,
        title: "Unabhängig irgendwann",
        status: "someday",
      });

      const unassignedProject = makeProject("Unzugewiesene Arbeit");
      const assignedScheduled = createTask(handle.db, {
        projectId: unassignedProject.id,
        title: "Terminiert",
        status: "waiting",
        scheduledDate: "2026-10-15",
      });
      const unassignedAction = createTask(handle.db, {
        projectId: unassignedProject.id,
        title: "Unzugewiesen blockiert",
        status: "actionable",
        ownerInheritanceMode: "none",
      });
      addDependency(handle.db, unassignedAction.id, assignedScheduled.id);

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(unscheduledProject.id)).toBe("blocked_dependencies");
      expect(reasons.get(capturedProject.id)).toBe("blocked_dependencies");
      expect(reasons.get(mixedProject.id)).toBe("blocked_dependencies");
      expect(reasons.get(unassignedProject.id)).toBe("unassigned_actionable");
    });

    it("requires every branch beneath future waiting work to have a clear endpoint", () => {
      const owner = createMember("Verschachtelt blockiert");
      const blockedProjects: number[] = [];

      const makeCase = (
        title: string,
        childStatus: "waiting" | "someday" | "actionable",
        captured = false,
      ) => {
        const project = createProject(handle.db, {
          title,
          status: "active",
          ownerMemberId: owner.id,
        });
        const scheduledWaiting = createTask(handle.db, {
          projectId: project.id,
          title: `${title} Wiedervorlage`,
          status: "waiting",
          scheduledDate: "2026-10-15",
        });
        const externalProject = createProject(handle.db, {
          title: `${title} externe Abhängigkeit`,
          status: "backlog",
          ownerMemberId: owner.id,
        });
        const child = createTask(handle.db, {
          projectId: externalProject.id,
          title: `${title} Unterblockierer`,
          status: childStatus,
        });
        if (captured) {
          handle.db
            .update(schema.tasks)
            .set({ needsClarification: true })
            .where(eq(schema.tasks.id, child.id))
            .run();
        }
        const action = createTask(handle.db, {
          projectId: project.id,
          title: `${title} Aktion`,
          status: "actionable",
        });
        addDependency(handle.db, scheduledWaiting.id, child.id);
        addDependency(handle.db, action.id, scheduledWaiting.id);
        return { project, scheduledWaiting };
      };

      blockedProjects.push(
        makeCase("Unterminiert unter Wiedervorlage", "waiting").project.id,
        makeCase("Erfasst unter Wiedervorlage", "waiting", true).project.id,
        makeCase("Irgendwann unter Wiedervorlage", "someday").project.id,
      );
      const actionable = makeCase(
        "Aktion unter Wiedervorlage",
        "actionable",
      );

      const branched = makeCase("Verzweigte Wiedervorlage", "waiting");
      blockedProjects.push(branched.project.id);
      const validBranchProject = createProject(handle.db, {
        title: "Terminierter externer Zweig",
        status: "backlog",
        ownerMemberId: owner.id,
      });
      const validBranch = createTask(handle.db, {
        projectId: validBranchProject.id,
        title: "Terminierter zweiter Zweig",
        status: "waiting",
        scheduledDate: "2026-10-20",
      });
      addDependency(handle.db, branched.scheduledWaiting.id, validBranch.id);

      const reasons = getStuckReasonsByProject(handle.db);
      for (const projectId of blockedProjects) {
        expect(reasons.get(projectId)).toBe("blocked_dependencies");
      }
      expect(reasons.has(actionable.project.id)).toBe(false);
    });

    it("keeps completion_review once the scheduled waiting task is closed", () => {
      const owner = createMember("Abschluss-Zuständige");

      const project = createProject(handle.db, {
        title: "Warten dann fertig",
        status: "active",
        ownerMemberId: owner.id,
      });

      const waitingTask = createTask(handle.db, {
        projectId: project.id,
        title: "Wartet mit Termin",
        status: "waiting",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      expect(getStuckReasonsByProject(handle.db).has(project.id)).toBe(false);

      updateTask(handle.db, waitingTask.id, { status: "done" });

      expect(getStuckReasonsByProject(handle.db).get(project.id)).toBe(
        "completion_review",
      );
    });

    it("does not treat open work in a terminal project as a viable dependency endpoint", () => {
      const owner = createMember("Terminaler Blocker");
      const activeProject = createProject(handle.db, {
        title: "Aktives Projekt",
        status: "active",
        ownerMemberId: owner.id,
      });
      const archivedProject = createProject(handle.db, {
        title: "Archiviertes Projekt",
        status: "archived",
        ownerMemberId: owner.id,
      });
      const archivedAction = createTask(handle.db, {
        projectId: archivedProject.id,
        title: "Versteckte offene Aufgabe",
      });
      const downstream = createTask(handle.db, {
        projectId: activeProject.id,
        title: "Davon abhängig",
      });
      addDependency(handle.db, downstream.id, archivedAction.id);

      expect(getStuckReasonsByProject(handle.db).get(activeProject.id)).toBe(
        "blocked_dependencies",
      );
    });

    it("flags an active project whose tasks are all done/cancelled as completion_review", () => {
      const owner = createMember("Abnahme-Zuständige");

      const allDone = createProject(handle.db, {
        title: "Alles Erledigt",
        status: "active",
        ownerMemberId: owner.id,
      });
      const doneTask = createTask(handle.db, {
        projectId: allDone.id,
        title: "Erledigt",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      updateTask(handle.db, doneTask.id, { status: "done" });

      const allClosedMixed = createProject(handle.db, {
        title: "Erledigt und Verworfen",
        status: "active",
        ownerMemberId: owner.id,
      });
      const cancelledTask = createTask(handle.db, {
        projectId: allClosedMixed.id,
        title: "Verworfen",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      updateTask(handle.db, cancelledTask.id, { status: "cancelled" });
      const doneTask2 = createTask(handle.db, {
        projectId: allClosedMixed.id,
        title: "Auch Erledigt",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      updateTask(handle.db, doneTask2.id, { status: "done" });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(allDone.id)).toBe("completion_review");
      expect(reasons.get(allClosedMixed.id)).toBe("completion_review");
    });

    it("excludes non-active projects regardless of task state (backlog, completed, archived)", () => {
      const owner = createMember("Backlog-Zuständige");

      const backlogEmpty = createProject(handle.db, {
        title: "Backlog Leer",
        status: "backlog",
      });

      const backlogOpen = createProject(handle.db, {
        title: "Backlog Offen",
        status: "backlog",
      });
      createTask(handle.db, {
        projectId: backlogOpen.id,
        title: "Wäre unassigned_actionable, wenn aktiv",
        status: "actionable",
      });

      const completedOpen = createProject(handle.db, {
        title: "Abgeschlossen mit offener Aufgabe",
        status: "completed",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: completedOpen.id,
        title: "Wäre blocked, wenn aktiv",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const archivedOpen = createProject(handle.db, {
        title: "Archiviert mit offener Aufgabe",
        status: "archived",
        ownerMemberId: owner.id,
      });
      createTask(handle.db, {
        projectId: archivedOpen.id,
        title: "Wäre actionable, wenn aktiv",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.has(backlogEmpty.id)).toBe(false);
      expect(reasons.has(backlogOpen.id)).toBe(false);
      expect(reasons.has(completedOpen.id)).toBe(false);
      expect(reasons.has(archivedOpen.id)).toBe(false);
    });
  });

  describe("moving and refiling subtrees without cycles", () => {
    it("cascades the project id across an arbitrarily deep subtree when refiled to a new project", () => {
      const source = createProject(handle.db, { title: "Quellprojekt" });
      const target = createProject(handle.db, { title: "Zielprojekt" });
      const root = createTask(handle.db, { projectId: source.id, title: "Wurzel" });
      const level1 = createTask(handle.db, { parentTaskId: root.id, title: "Ebene 1" });
      const level2 = createTask(handle.db, { parentTaskId: level1.id, title: "Ebene 2" });
      const level3 = createTask(handle.db, { parentTaskId: level2.id, title: "Ebene 3" });

      moveSubtreeToProject(handle.db, root.id, target.id);

      const rows = handle.db
        .select()
        .from(schema.tasks)
        .all()
        .filter((t) => [root.id, level1.id, level2.id, level3.id].includes(t.id));
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.projectId).toBe(target.id);
      }
    });

    it("rejects re-parenting a task under its own descendant, at the mutation layer", () => {
      const root = createTask(handle.db, { title: "Wurzel" });
      const child = createTask(handle.db, { parentTaskId: root.id, title: "Kind" });
      const grandchild = createTask(handle.db, { parentTaskId: child.id, title: "Enkelkind" });

      expect(() => moveTask(handle.db, root.id, { parentTaskId: grandchild.id })).toThrow();

      const reloaded = handle.db
        .select()
        .from(schema.tasks)
        .all()
        .find((t) => t.id === root.id)!;
      expect(reloaded.parentTaskId).toBeNull();
    });

    it("rejects a task becoming its own parent, at the mutation layer", () => {
      const task = createTask(handle.db, { title: "Selbst" });
      expect(() => moveTask(handle.db, task.id, { parentTaskId: task.id })).toThrow();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  describe("stuck-project classification", () => {
    it("classifies unassigned_actionable, only_waiting, no_next_action, blocked_dependencies and healthy projects", () => {
      const owner = createMember("Zuständige Person");

      const unassigned = createProject(handle.db, { title: "Unzugewiesen" });
      createTask(handle.db, {
        projectId: unassigned.id,
        title: "Offen",
        status: "actionable",
      });

      const onlyWaiting = createProject(handle.db, {
        title: "Nur Warten",
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

      const healthy = createProject(handle.db, { title: "Gesund", ownerMemberId: owner.id });
      createTask(handle.db, {
        projectId: healthy.id,
        title: "Machbar",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(unassigned.id)).toBe("unassigned_actionable");
      expect(reasons.get(onlyWaiting.id)).toBe("only_waiting");
      expect(reasons.get(noNextAction.id)).toBe("no_next_action");
      expect(reasons.get(blockedProject.id)).toBe("blocked_dependencies");
      expect(reasons.has(healthy.id)).toBe(false);
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../src/db/client.js";
import { createTestDatabase } from "./database.js";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { createProject as createProjectMutation } from "../src/domain/storyCrud.js";
import { moveTask } from "../src/domain/structuralMoves.js";
import { getOrCreateTag } from "../src/domain/tags.js";
import { addDependency } from "../src/domain/taskCapabilities.js";
import { createTask, updateTask } from "../src/domain/taskCrud.js";
import {
  getBlockedTaskIds,
  wouldCreateDependencyCycle,
} from "../src/repo/dependencyRepo.js";
import {
  getEffectiveOwners,
  getEffectiveTagIds,
} from "../src/repo/effectiveRepo.js";
import {
  getNextActionTaskIdsByProject,
  getNextActionTaskIdsByProjectProjection,
  type NextActionTaskIdsByProject,
} from "../src/repo/nextActionRepo.js";
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
    handle = createTestDatabase();
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

  function createProject(
    ...args: Parameters<typeof createProjectMutation>
  ): ReturnType<typeof createProjectMutation> {
    const [db, input, context] = args;
    const requestedActive = input.status === "active" ||
      (input.status === undefined && input.scope !== "work" && input.ownerMemberId != null);
    const project = createProjectMutation(
      db,
      requestedActive ? { ...input, status: "backlog", ownerMemberId: null } : input,
      context,
    );
    if (!requestedActive) return project;
    db.update(schema.workItems)
      .set({ status: "active", ownerMemberId: input.ownerMemberId ?? null })
      .where(eq(schema.workItems.id, project.id))
      .run();
    return { ...project, status: "active" };
  }

  function addExternalWait(
    taskId: number,
    waitingFor = "External event",
    revisitDate: string | null = null,
  ) {
    handle.db
      .insert(schema.taskExternalWaits)
      .values({ taskId, waitingFor, revisitDate })
      .run();
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

  describe("effective owner/tags", () => {
    it("computes owner inheritance for every task in one pass and labels the source correctly", () => {
      const projectOwner = createMember("Projektinhaberin");
      const parentOwner = createMember("Elternzuständiger");
      const project = createProject(handle.db, {
        title: "Projekt",
        ownerMemberId: projectOwner.id,
      });
      const root = createTask(handle.db, { projectId: project.id, title: "Wurzel" });
      const explicitParent = updateTask(handle.db, root.id, {
        ownerMemberId: parentOwner.id,
        ownerInheritanceMode: "explicit",
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
      });

      const effective = getEffectiveOwners(handle.db);
      expect(effective.get(explicitParent.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "task",
      });
      expect(effective.get(child.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "parent",
      });
      expect(effective.get(grandchild.id)).toMatchObject({
        ownerId: parentOwner.id,
        ownerSource: "parent",
      });
      expect(effective.get(optedOut.id)).toMatchObject({
        ownerId: null,
        ownerSource: "none",
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
    // Frozen pre-optimization SQL retained only as a differential test oracle.
    // Keep this query aligned with the canonical implementation at the #350 base.
    function getBaselineNextActionTaskIdsByProjectProjection(
      db: Db,
      now = new Date().toISOString(),
    ): NextActionTaskIdsByProject {
      const rows = db.all<{
        project_id: number | null;
        task_id: number;
        availability: "available" | "deferred" | "project_container" | "work_container" | "work_descendant";
        key: string | null;
        descendant_id: number | null;
      }>(sql`
        WITH RECURSIVE sortkey(task_id, project_id, key) AS (
          SELECT task.id, story.id, printf('%08d', task.position)
          FROM work_items task
          JOIN work_items story ON story.id = task.parent_id AND story.role = 'story'
          WHERE task.role = 'task'
          UNION ALL
          SELECT task.id, sk.project_id, sk.key || '.' || printf('%08d', task.position)
          FROM work_items task
          JOIN sortkey sk ON task.parent_id = sk.task_id
          WHERE task.role = 'task'
        ),
        task_descendants(ancestor_id, descendant_id) AS (
          SELECT id, id FROM work_items WHERE role = 'task'
          UNION ALL
          SELECT td.ancestor_id, child.id
          FROM task_descendants td
          JOIN work_items child ON child.parent_id = td.descendant_id
          -- An open project is part of the containing task's structure. A
          -- terminal project's historical subtree is outside that task's work.
          WHERE child.role = 'task' OR (
            child.role = 'story' AND child.archived_at IS NULL
            AND child.status NOT IN ('done', 'cancelled')
          )
        ),
        blocking_descendants AS (
          -- Open actions and projects keep their task ancestors as containers.
          -- Reference nodes remain transparent; terminal project subtrees stop above.
          SELECT td.ancestor_id AS task_id, td.descendant_id
          FROM task_descendants td
          JOIN work_items descendant ON descendant.id = td.descendant_id
          WHERE td.descendant_id != td.ancestor_id
            AND COALESCE(descendant.task_kind, 'action') = 'action'
            AND descendant.status NOT IN ('done', 'cancelled')
        ),
        candidates AS (
          SELECT sk.task_id, sk.project_id, sk.key
          FROM sortkey sk
          JOIN work_items t ON t.id = sk.task_id
          WHERE sk.project_id IS NOT NULL
            AND t.status = 'active'
            AND COALESCE(t.task_kind, 'action') = 'action'
            AND NOT EXISTS (
              SELECT 1 FROM task_dependencies td
              JOIN work_items dep ON dep.id = td.depends_on_task_id
              WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled')
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_external_waits ew WHERE ew.task_id = t.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM blocking_descendants bd WHERE bd.task_id = t.id
            )
        ),
        eligible AS (
          SELECT c.project_id, c.task_id, c.key,
            CASE
             WHEN t.revisit_at IS NULL OR julianday(t.revisit_at) <= julianday(${now})
               THEN 'available'
             ELSE 'deferred'
            END AS availability
          FROM candidates c
          JOIN work_items t ON t.id = c.task_id
        )
        SELECT project_id, task_id, availability, key, NULL AS descendant_id FROM eligible
        UNION ALL
        SELECT NULL, td.ancestor_id, 'project_container', NULL, NULL
        FROM task_descendants td
        JOIN work_items descendant ON descendant.id = td.descendant_id
        WHERE descendant.role = 'story'
        GROUP BY td.ancestor_id
        UNION ALL
        SELECT NULL, task_id, 'work_container', NULL, NULL
        FROM (SELECT DISTINCT task_id FROM blocking_descendants)
        UNION ALL
        SELECT NULL, task_id, 'work_descendant', NULL, descendant_id
        FROM blocking_descendants
        ORDER BY project_id, key
      `);
      const openProjectContainers = new Set<number>();
      const unfinishedWorkContainers = new Set<number>();
      const unfinishedWorkDescendantsByContainer = new Map<number, number[]>();
      const available = new Map<number, number[]>();
      const ordered = new Map<
        number,
        Array<{ taskId: number; availability: "available" | "deferred" }>
      >();
      for (const row of rows) {
        if (row.availability === "work_descendant") {
          if (row.descendant_id !== null) {
            const descendants =
              unfinishedWorkDescendantsByContainer.get(row.task_id) ?? [];
            descendants.push(row.descendant_id);
            unfinishedWorkDescendantsByContainer.set(row.task_id, descendants);
          }
          continue;
        }
        if (row.availability === "work_container") {
          unfinishedWorkContainers.add(row.task_id);
          continue;
        }
        if (row.availability === "project_container") {
          openProjectContainers.add(row.task_id);
          continue;
        }
        if (row.project_id === null) continue;
        if (row.availability === "available") {
          const ids = available.get(row.project_id) ?? [];
          ids.push(row.task_id);
          available.set(row.project_id, ids);
        }
        const candidates = ordered.get(row.project_id) ?? [];
        candidates.push({ taskId: row.task_id, availability: row.availability });
        ordered.set(row.project_id, candidates);
      }
      return {
        available,
        ordered,
        openProjectContainers,
        unfinishedWorkContainers,
        unfinishedWorkDescendantsByContainer,
      };
    }
    

    it("preserves the full projection through reference, waiting, deferred, and terminal descendants", () => {
      const project = createProject(handle.db, { title: "Projektionsäquivalenz", status: "active" });
      const root = createTask(handle.db, {
        projectId: project.id,
        title: "Wurzel",
        status: "actionable",
      });
      const reference = createTask(handle.db, {
        parentTaskId: root.id,
        title: "Referenz",
        kind: "reference",
      });
      const waiting = createTask(handle.db, {
        parentTaskId: reference.id,
        title: "Wartende Aktion",
        status: "actionable",
      });
      addExternalWait(waiting.id);
      const deferred = createTask(handle.db, {
        parentTaskId: reference.id,
        title: "Zurückgestellte Aktion",
        status: "actionable",
        revisitAt: "2099-01-01T00:00:00.000Z",
      });
      const terminal = createTask(handle.db, {
        parentTaskId: reference.id,
        title: "Erledigte Aktion",
        status: "actionable",
      });
      updateTask(handle.db, terminal.id, { status: "done" });
      const dependencyBlocker = createTask(handle.db, {
        parentTaskId: reference.id,
        title: "Offener Abhängigkeitsblocker",
        status: "actionable",
      });
      const blocked = createTask(handle.db, {
        parentTaskId: reference.id,
        title: "Abhängige Aktion",
        status: "actionable",
      });
      addDependency(handle.db, blocked.id, dependencyBlocker.id);

      const projection = getNextActionTaskIdsByProjectProjection(
        handle.db,
        "2026-11-21T00:00:00.000Z",
      );

      expect(projection.openProjectContainers).toEqual(new Set());
      expect(projection.unfinishedWorkContainers).toEqual(new Set([root.id, reference.id]));
      expect(projection.unfinishedWorkDescendantsByContainer).toEqual(
        new Map([
          [root.id, [waiting.id, deferred.id, dependencyBlocker.id, blocked.id]],
          [reference.id, [waiting.id, deferred.id, dependencyBlocker.id, blocked.id]],
        ]),
      );
      expect(projection.ordered).toEqual(
        new Map([[
          project.id,
          [
            { taskId: deferred.id, availability: "deferred" },
            { taskId: dependencyBlocker.id, availability: "available" },
          ],
        ]]),
      );
      expect(projection.available).toEqual(
        new Map([[project.id, [dependencyBlocker.id]]]),
      );
      expect(projection).toEqual(
        getBaselineNextActionTaskIdsByProjectProjection(handle.db, "2026-11-21T00:00:00.000Z"),
      );
    });

    it("includes active project descendants as containers and stops at terminal projects", () => {
      const project = createProject(handle.db, { title: "Projektstatus", status: "active" });
      const container = createTask(handle.db, {
        projectId: project.id,
        title: "Projekt enthaltende Aufgabe",
        status: "actionable",
      });
      const childProject = handle.db
        .insert(schema.workItems)
        .values({
          role: "story",
          parentId: container.id,
          title: "Unterprojekt",
          status: "active",
        })
        .returning()
        .get();
      const openAction = handle.db
        .insert(schema.workItems)
        .values({
          role: "task",
          parentId: childProject.id,
          title: "Offene Unteraufgabe",
          status: "active",
          taskKind: "action",
        })
        .returning()
        .get();

      const activeProjection = getNextActionTaskIdsByProjectProjection(
        handle.db,
        "2026-11-21T00:00:00.000Z",
      );
      expect(activeProjection.openProjectContainers).toEqual(new Set([container.id]));
      expect(activeProjection.unfinishedWorkContainers).toEqual(new Set([container.id]));
      expect(activeProjection.unfinishedWorkDescendantsByContainer).toEqual(
        new Map([[container.id, [childProject.id, openAction.id]]]),
      );
      expect(activeProjection.available).toEqual(new Map([[childProject.id, [openAction.id]]]));
      expect(activeProjection).toEqual(
        getBaselineNextActionTaskIdsByProjectProjection(handle.db, "2026-11-21T00:00:00.000Z"),
      );

      handle.db
        .update(schema.workItems)
        .set({ status: "done" })
        .where(eq(schema.workItems.id, childProject.id))
        .run();

      const terminalProjection = getNextActionTaskIdsByProjectProjection(
        handle.db,
        "2026-11-21T00:00:00.000Z",
      );
      expect(terminalProjection.openProjectContainers).toEqual(new Set());
      expect(terminalProjection.unfinishedWorkContainers).toEqual(new Set());
      expect(terminalProjection.unfinishedWorkDescendantsByContainer).toEqual(new Map());
      expect(terminalProjection.available).toEqual(
        new Map([
          [project.id, [container.id]],
          [childProject.id, [openAction.id]],
        ]),
      );
      expect(terminalProjection).toEqual(
        getBaselineNextActionTaskIdsByProjectProjection(handle.db, "2026-11-21T00:00:00.000Z"),
      );
    });

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
        status: "actionable",
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
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(rootChild.id);

      updateTask(handle.db, blocker.id, { status: "done" });
      // root has an open child, so it remains a container even once
      // unblocked -- rootChild still wins, never the parent.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(rootChild.id);

      updateTask(handle.db, rootChild.id, { status: "done" });
      // Once every child of root is terminal, root itself is free to
      // become a candidate again.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(root.id);
    });

    it("suppresses a parent as a candidate while it has any open child (container semantics)", () => {
      const project = createProject(handle.db, { title: "Container" });
      const parent = createTask(handle.db, {
        projectId: project.id,
        title: "Elternaufgabe",
        status: "actionable",
      });
      const child = createTask(handle.db, {
        parentTaskId: parent.id,
        title: "Offenes Kind",
        status: "actionable",
      });

      const ids = getNextActionTaskIdsByProject(handle.db).get(project.id) ?? [];
      expect(ids).toContain(child.id);
      expect(ids).not.toContain(parent.id);
    });

    it("excludes tasks that are not yet available", () => {
      const project = createProject(handle.db, { title: "Verfügbarkeit" });
      const deferred = createTask(handle.db, {
        projectId: project.id,
        title: "Später",
        status: "actionable",
        notBeforeAt: "2026-09-20T08:00:00.000Z",
        notBeforeDate: "2026-09-20",
      });
      const available = createTask(handle.db, {
        projectId: project.id,
        title: "Jetzt",
        status: "actionable",
      });

      const ids = getNextActionTaskIdsByProject(
        handle.db,
        "2026-09-19T14:00:00.000Z",
      ).get(project.id);
      expect(ids).toEqual([available.id]);
      expect(ids).not.toContain(deferred.id);
    });

    it("selects the first eligible leaf across multiple open descendants in outline order", () => {
      const project = createProject(handle.db, { title: "Tiefe Struktur" });
      const root = createTask(handle.db, {
        projectId: project.id,
        title: "Wurzel",
        status: "actionable",
      });
      const child = createTask(handle.db, {
        parentTaskId: root.id,
        title: "Kind",
        status: "actionable",
      });
      const grandchild = createTask(handle.db, {
        parentTaskId: child.id,
        title: "Enkelkind",
        status: "actionable",
      });
      const laterGrandchild = createTask(handle.db, {
        parentTaskId: child.id,
        title: "Späteres Enkelkind",
        status: "actionable",
      });

      // root and child are both containers (each has an open child), so
      // the first genuine leaf in pre-order -- the grandchild -- wins.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(
        grandchild.id,
      );

      updateTask(handle.db, grandchild.id, { status: "cancelled" });
      // With the first grandchild terminal, child still has an open
      // child (laterGrandchild), so it remains a container too.
      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(
        laterGrandchild.id,
      );
    });

    it("makes a parent a candidate again once every child is done/cancelled", () => {
      const project = createProject(handle.db, { title: "Abgeschlossene Kinder" });
      const parent = createTask(handle.db, {
        projectId: project.id,
        title: "Elternaufgabe",
        status: "actionable",
      });
      const doneChild = createTask(handle.db, {
        parentTaskId: parent.id,
        title: "Erledigtes Kind",
        status: "actionable",
      });
      const cancelledChild = createTask(handle.db, {
        parentTaskId: parent.id,
        title: "Storniertes Kind",
        status: "actionable",
      });
      updateTask(handle.db, doneChild.id, { status: "done" });
      updateTask(handle.db, cancelledChild.id, { status: "cancelled" });

      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(parent.id);
    });

    it("reaches an eligible child even while its parent is blocked/waiting", () => {
      const project = createProject(handle.db, { title: "Blockierte Eltern" });
      const blockingDependency = createTask(handle.db, {
        projectId: project.id,
        title: "Abhängigkeit",
        status: "actionable",
      });
      const waitingParent = createTask(handle.db, {
        projectId: project.id,
        title: "Wartende Elternaufgabe",
        status: "actionable",
      });
      addDependency(handle.db, waitingParent.id, blockingDependency.id);
      addExternalWait(waitingParent.id);
      const child = createTask(handle.db, {
        parentTaskId: waitingParent.id,
        title: "Erreichbares Kind",
        status: "actionable",
      });

      const ids = getNextActionTaskIdsByProject(handle.db).get(project.id) ?? [];
      expect(ids).toContain(child.id);
      expect(ids).not.toContain(waitingParent.id);
    });

    it("omits a project with no actionable candidates from the result map", () => {
      const project = createProject(handle.db, { title: "Nur Warten" });
      const waiting = createTask(handle.db, { projectId: project.id, title: "Wartet", status: "actionable" });
      addExternalWait(waiting.id);
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
        .prepare("UPDATE work_items SET status = 'captured', needs_clarification = 1 WHERE id IN (?, ?)")
        .run(capturedRoot.id, capturedBlocker.id);

      expect(getNextActionTaskIdsByProject(handle.db).get(project.id)?.[0]).toBe(
        laterChild.id,
      );
    });

    it("keeps depth-first sibling `position` ordering unchanged among leaf candidates", () => {
      const project = createProject(handle.db, { title: "Reihenfolge" });
      const first = createTask(handle.db, {
        projectId: project.id,
        title: "Erste Wurzel",
        status: "actionable",
      });
      const second = createTask(handle.db, {
        projectId: project.id,
        title: "Zweite Wurzel",
        status: "actionable",
      });
      const firstChild = createTask(handle.db, {
        parentTaskId: first.id,
        title: "Kind der ersten Wurzel",
        status: "actionable",
      });

      // first is a container (open child), so its child comes before the
      // later top-level sibling, exactly as pre-order/position dictate.
      const ids = getNextActionTaskIdsByProject(handle.db).get(project.id) ?? [];
      expect(ids).toEqual([firstChild.id, second.id]);
    });
  });

  describe("stuck-project classification", () => {
    it("classifies structural blockers while allowing shared actionable work", () => {
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
      const onlyWaitingTask = createTask(handle.db, {
        projectId: onlyWaiting.id,
        title: "Wartet",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(onlyWaitingTask.id);

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
        status: "captured",
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
      expect(reasons.has(unassigned.id)).toBe(false);
      expect(reasons.get(onlyWaiting.id)).toBe("waiting_without_followup");
      expect(reasons.get(noNextAction.id)).toBe("no_next_action");
      expect(reasons.get(blockedProject.id)).toBe("blocked_without_clear_path");
      expect(reasons.has(healthy.id)).toBe(false);
    });

    it("prefers external-wait specificity over unassigned when no healthy path exists", () => {
      const project = createProject(handle.db, {
        title: "Unzugewiesen und wartet",
        status: "active",
      });
      const task = createTask(handle.db, {
        projectId: project.id,
        title: "Rückmeldung fehlt",
        status: "actionable",
        ownerInheritanceMode: "none",
      });
      addExternalWait(task.id, "Behörde");

      expect(getStuckReasonsByProject(handle.db).get(project.id)).toBe(
        "waiting_without_followup",
      );
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
        status: "actionable",
      });
      handle.sqlite
        .prepare("UPDATE work_items SET status = 'captured', needs_clarification = 1 WHERE id IN (?, ?)")
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
        .prepare("UPDATE work_items SET status = 'captured', needs_clarification = 1 WHERE id = ?")
        .run(mixedRoot.id);

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(capturedOnly.id)).toBe("no_next_action");
      expect(reasons.has(mixed.id)).toBe(false);
    });

    it("keeps a project parked when any external-wait path has a future revisit", () => {
      const owner = createMember("Wiedervorlage-Zuständige");

      const withRevisit = createProject(handle.db, {
        title: "Warten mit Wiedervorlage",
        status: "active",
        ownerMemberId: owner.id,
      });
      const scheduledWait = createTask(handle.db, {
        projectId: withRevisit.id,
        title: "Wartet mit Termin",
        status: "actionable",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(scheduledWait.id, "External event", "2026-09-01");
      const unscheduledWait = createTask(handle.db, {
        projectId: withRevisit.id,
        title: "Wartet ohne Termin",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(unscheduledWait.id);

      const reasons = getStuckReasonsByProject(handle.db, "2026-08-25");
      expect(reasons.has(withRevisit.id)).toBe(true);
    });

    it("keeps future and reached revisits out of project stuck reasons", () => {
      const owner = createMember("Termin-Zuständige");
      const today = new Date().toISOString().slice(0, 10);

      const projectIds = ["2020-01-01", today, "2099-12-31"].map((scheduledDate) => {
        const project = createProject(handle.db, {
          title: `Warten bis ${scheduledDate}`,
          status: "active",
          ownerMemberId: owner.id,
        });
        const waiting = createTask(handle.db, {
          projectId: project.id,
          title: "Wartet",
          status: "actionable",
          scheduledDate,
          ownerMemberId: owner.id,
          ownerInheritanceMode: "explicit",
        });
        addExternalWait(waiting.id, "External event", scheduledDate);
        return project.id;
      });

      const reasons = getStuckReasonsByProject(handle.db, today);
      expect(reasons.has(projectIds[0]!)).toBe(false);
      expect(reasons.has(projectIds[1]!)).toBe(false);
      expect(reasons.has(projectIds[2]!)).toBe(false);
    });

    it("does not let a reached revisit mask a structural blocker", () => {
      const owner = createMember("Gemischte-Diagnose-Zuständige");
      const today = new Date().toISOString().slice(0, 10);
      const project = createProject(handle.db, {
        title: "Nachhaken und Blockade",
        status: "active",
        ownerMemberId: owner.id,
      });
      const waiting = createTask(handle.db, {
        projectId: project.id,
        title: "Heute nachhaken",
        status: "actionable",
        scheduledDate: today,
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(waiting.id, "External event", today);
      const capturedBlocker = createTask(handle.db, {
        projectId: project.id,
        title: "Ungeklärte Voraussetzung",
        status: "captured",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      const structurallyBlocked = createTask(handle.db, {
        projectId: project.id,
        title: "Kann noch nicht weiter",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addDependency(handle.db, structurallyBlocked.id, capturedBlocker.id);

      expect(
        getStuckReasonsByProject(handle.db, today).get(project.id),
      ).toBe("blocked_without_clear_path");
    });

    it("still flags only_waiting when the revisit date is missing or blank", () => {
      const owner = createMember("Ohne-Termin-Zuständige");

      const nullDate = createProject(handle.db, {
        title: "Warten ohne Termin",
        status: "active",
        ownerMemberId: owner.id,
      });
      const nullWait = createTask(handle.db, {
        projectId: nullDate.id,
        title: "Wartet",
        status: "actionable",
        scheduledDate: null,
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(nullWait.id);

      const blankDate = createProject(handle.db, {
        title: "Warten mit leerem Termin",
        status: "active",
        ownerMemberId: owner.id,
      });
      const blankTask = createTask(handle.db, {
        projectId: blankDate.id,
        title: "Wartet",
        status: "actionable",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(blankTask.id);
      handle.db
        .update(schema.taskExternalWaits)
        .set({ revisitDate: "" })
        .where(eq(schema.taskExternalWaits.taskId, blankTask.id))
        .run();

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(nullDate.id)).toBe("waiting_without_followup");
      expect(reasons.get(blankDate.id)).toBe("waiting_without_followup");
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
      const somedayWait = createTask(handle.db, {
        projectId: mixedSomeday.id,
        title: "Wartet mit Termin",
        status: "actionable",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(somedayWait.id, "External event", "2026-09-01");
      createTask(handle.db, {
        projectId: mixedSomeday.id,
        title: "Irgendwann",
        status: "someday",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });

      // Shared actionable work remains a healthy path.
      const mixedUnassigned = createProject(handle.db, {
        title: "Warten und Unzugewiesen",
        status: "active",
        ownerMemberId: owner.id,
      });
      const unassignedWait = createTask(handle.db, {
        projectId: mixedUnassigned.id,
        title: "Wartet mit Termin",
        status: "actionable",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(unassignedWait.id, "External event", "2026-09-01");
      createTask(handle.db, {
        projectId: mixedUnassigned.id,
        title: "Offen ohne Zuständige",
        status: "actionable",
        ownerInheritanceMode: "none",
      });

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.has(mixedSomeday.id)).toBe(false);
      expect(reasons.has(mixedUnassigned.id)).toBe(false);
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
        status: "actionable",
        scheduledDate: "2026-10-15",
      });
      addExternalWait(scheduled.id, "External event", "2026-10-15");
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
        status: "actionable",
      });
      addExternalWait(unscheduled.id);
      const unscheduledAction = makeAction(unscheduledProject.id, "Blockiert");
      addDependency(handle.db, unscheduledAction.id, unscheduled.id);

      const capturedProject = makeProject("Erfasster Blockierer");
      const captured = createTask(handle.db, {
        projectId: capturedProject.id,
        title: "Erfasst und terminiert",
        status: "actionable",
        scheduledDate: "2026-10-15",
      });
      handle.db
        .update(schema.workItems)
        .set({ status: "captured", needsClarification: true })
        .where(eq(schema.workItems.id, captured.id))
        .run();
      const capturedAction = makeAction(capturedProject.id, "Blockiert");
      addDependency(handle.db, capturedAction.id, captured.id);

      const mixedProject = makeProject("Unabhängige offene Arbeit");
      const scheduled = createTask(handle.db, {
        projectId: mixedProject.id,
        title: "Terminiert",
        status: "actionable",
        scheduledDate: "2026-10-15",
      });
      addExternalWait(scheduled.id, "External event", "2026-10-15");
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
        status: "actionable",
        scheduledDate: "2026-10-15",
      });
      addExternalWait(
        assignedScheduled.id,
        "External event",
        "2026-10-15",
      );
      const unassignedAction = createTask(handle.db, {
        projectId: unassignedProject.id,
        title: "Unzugewiesen blockiert",
        status: "actionable",
        ownerInheritanceMode: "none",
      });
      addDependency(handle.db, unassignedAction.id, assignedScheduled.id);

      const reasons = getStuckReasonsByProject(handle.db);
      expect(reasons.get(unscheduledProject.id)).toBe("waiting_without_followup");
      expect(reasons.get(capturedProject.id)).toBe("blocked_without_clear_path");
      expect(reasons.has(mixedProject.id)).toBe(false);
      expect(reasons.has(unassignedProject.id)).toBe(false);
    });

    it("requires every branch beneath future waiting work to have a clear endpoint", () => {
      const owner = createMember("Verschachtelt blockiert");
      const blockedWithoutPath: number[] = [];
      const waitingWithoutFollowup: number[] = [];

      const makeCase = (
        title: string,
        childStatus: "external" | "someday" | "actionable",
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
          status: "actionable",
          scheduledDate: "2026-10-15",
        });
        addExternalWait(
          scheduledWaiting.id,
          "External event",
          "2026-10-15",
        );
        const externalProject = createProject(handle.db, {
          title: `${title} externe Abhängigkeit`,
          status: "active",
          ownerMemberId: owner.id,
        });
        const child = createTask(handle.db, {
          projectId: externalProject.id,
          title: `${title} Unterblockierer`,
          status: childStatus === "someday" ? "someday" : "actionable",
        });
        if (childStatus === "external") addExternalWait(child.id);
        if (captured) {
          handle.db
            .update(schema.workItems)
            .set({ status: "captured", needsClarification: true })
            .where(eq(schema.workItems.id, child.id))
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

      waitingWithoutFollowup.push(
        makeCase("Unterminiert unter Wiedervorlage", "external").project.id,
      );
      blockedWithoutPath.push(
        makeCase("Erfasst unter Wiedervorlage", "external", true).project.id,
        makeCase("Irgendwann unter Wiedervorlage", "someday").project.id,
      );
      const actionable = makeCase(
        "Aktion unter Wiedervorlage",
        "actionable",
      );

      const branched = makeCase("Verzweigte Wiedervorlage", "external");
      waitingWithoutFollowup.push(branched.project.id);
      const validBranchProject = createProject(handle.db, {
        title: "Terminierter externer Zweig",
        status: "active",
        ownerMemberId: owner.id,
      });
      const validBranch = createTask(handle.db, {
        projectId: validBranchProject.id,
        title: "Terminierter zweiter Zweig",
        status: "actionable",
        scheduledDate: "2026-10-20",
      });
      addExternalWait(validBranch.id, "External event", "2026-10-20");
      addDependency(handle.db, branched.scheduledWaiting.id, validBranch.id);

      const reasons = getStuckReasonsByProject(handle.db);
      for (const projectId of blockedWithoutPath) {
        expect(reasons.get(projectId)).toBe("blocked_without_clear_path");
      }
      for (const projectId of waitingWithoutFollowup) {
        expect(reasons.get(projectId)).toBe("waiting_without_followup");
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
        status: "actionable",
        scheduledDate: "2026-09-01",
        ownerMemberId: owner.id,
        ownerInheritanceMode: "explicit",
      });
      addExternalWait(waitingTask.id, "External event", "2026-09-01");

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
        "blocked_without_clear_path",
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
        title: "Geteilte offene Aufgabe",
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

      moveTask(handle.db, root.id, {
        parentTaskId: null,
        projectId: target.id,
        expectedRevision: root.revision,
      });

      const reloaded = Graph.load(handle.db);
      for (const id of [root.id, level1.id, level2.id, level3.id]) {
        expect(reloaded.tasksById.get(id)?.projectId).toBe(target.id);
      }
    });

    it("rejects re-parenting a task under its own descendant, at the mutation layer", () => {
      const root = createTask(handle.db, { title: "Wurzel" });
      const child = createTask(handle.db, { parentTaskId: root.id, title: "Kind" });
      const grandchild = createTask(handle.db, { parentTaskId: child.id, title: "Enkelkind" });

      expect(() =>
        moveTask(handle.db, root.id, {
          parentTaskId: grandchild.id,
          expectedRevision: root.revision,
        }),
      ).toThrow();

      const reloaded = handle.db
        .select()
        .from(schema.workItems)
        .all()
        .find((t) => t.id === root.id)!;
      expect(reloaded.parentId).toBeNull();
    });

    it("rejects a task becoming its own parent, at the mutation layer", () => {
      const task = createTask(handle.db, { title: "Selbst" });
      expect(() =>
        moveTask(handle.db, task.id, {
          parentTaskId: task.id,
          expectedRevision: task.revision,
        }),
      ).toThrow();
    });
  });
});

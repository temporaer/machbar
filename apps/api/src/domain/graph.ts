import type {
  AcceptanceCriterion,
  Dependency,
  InheritanceMode,
  Project as SharedProject,
  ProjectStatus,
  StuckReason,
  Tag,
  Task as SharedTask,
  TaskSize,
  TaskStatus,
} from "@machbar/shared";
import { stuckReasonLabels } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  availableProjectWorkflowActions,
  type ProjectWorkflowAction,
} from "./mutations.js";
import {
  getBlockedTaskIds,
  getEffectiveOwnersAndContexts,
  getEffectiveTagIds,
  getNextActionTaskIdsByProject,
  getStuckReasonsByProject,
} from "../repo/index.js";

export interface ProjectRecord extends SharedProject {
  /** Workflow actions currently legal for this project's status (see
   * `availableProjectWorkflowActions` in `domain/mutations.ts`); not part
   * of the shared `Project` contract, purely an API-response convenience. */
  availableActions: ProjectWorkflowAction[];
}

export interface TaskRecord extends SharedTask {}

export interface StuckProjectRecord extends ProjectRecord {
  stuckReason: StuckReason;
  repairAction: string;
}

export const repairActionByReason: Record<StuckReason, string> = {
  no_next_action:
    "Lege eine machbare nächste Aufgabe für dieses Projekt fest.",
  only_waiting:
    "Hake bei den wartenden Aufgaben nach, setze eine Wiedervorlage oder plane einen eigenen nächsten Schritt.",
  blocked_dependencies:
    "Löse die blockierenden Abhängigkeiten auf, um weiterzukommen.",
  unassigned_actionable:
    "Weise die offene Aufgabe einer zuständigen Person zu.",
  completion_review:
    "Schließe das Projekt ab, öffne es erneut oder archiviere es.",
};

function dedupeTags(tags: Tag[]): Tag[] {
  const seen = new Map<number, Tag>();
  for (const tag of tags) {
    if (!seen.has(tag.id)) seen.set(tag.id, tag);
  }
  return [...seen.values()];
}

interface RawTask {
  id: number;
  projectId: number | null;
  parentTaskId: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  needsClarification: boolean;
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  createdByMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  waitingFor: string | null;
  context: string | null;
  contextInheritanceMode: InheritanceMode;
  priority: number | null;
  size: TaskSize | null;
  position: number;
  completedAt: string | null;
  cancelledAt: string | null;
  recurrenceRule: string | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawProject {
  id: number;
  title: string;
  status: ProjectStatus;
  ownerMemberId: number | null;
  context: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  position: number;
}

/**
 * Assembles the fully computed project/task shapes described by
 * @machbar/shared for API responses.
 *
 * `Graph` is deliberately a thin *service/repository-composition* layer: it
 * issues a handful of ordinary Drizzle CRUD selects for the raw rows, and
 * delegates every non-trivial derivation — effective owner/context/tags
 * inheritance, dependency-based blocking, next-action selection and
 * "Festgefahren" (stuck) classification — to the SQL/CTE-based functions in
 * `src/repo/*`. The only tree-shaped work still done here is building the
 * plain parent→children adjacency used purely to *shape* the nested
 * `Task.children` output array; no inheritance/blocking/stuck business
 * logic is computed by walking that adjacency in application code.
 */
export class Graph {
  readonly projectsById = new Map<number, ProjectRecord>();
  readonly tasksById = new Map<number, TaskRecord>();
  readonly childrenByParent = new Map<number | null, TaskRecord[]>();
  readonly rootsByProject = new Map<number | null, TaskRecord[]>();
  private readonly stuckReasonByProject: Map<number, StuckReason>;
  private readonly nextActionIdByProject: Map<number, number>;

  private constructor(
    stuckReasonByProject: Map<number, StuckReason>,
    nextActionIdByProject: Map<number, number>,
  ) {
    this.stuckReasonByProject = stuckReasonByProject;
    this.nextActionIdByProject = nextActionIdByProject;
  }

  static load(db: Db): Graph {
    // --- SQL/CTE-computed derivations (repo layer) ---------------------
    const effectiveOwnerContext = getEffectiveOwnersAndContexts(db);
    const effectiveTagIdsByTask = getEffectiveTagIds(db);
    const blockedTaskIds = getBlockedTaskIds(db);
    const nextActionIdByProject = getNextActionTaskIdsByProject(db);
    const stuckReasonByProject = getStuckReasonsByProject(db);

    const graph = new Graph(stuckReasonByProject, nextActionIdByProject);

    // --- ordinary CRUD reads (plain Drizzle query builder) --------------
    const rawProjects = db.select().from(schema.projects).all() as RawProject[];
    const rawTasks = db.select().from(schema.tasks).all() as RawTask[];
    const allTags = db.select().from(schema.tags).all() as Tag[];
    const tagsById = new Map(allTags.map((t) => [t.id, t]));

    const projectTagRows = db.select().from(schema.projectTags).all();
    const projectTagsByProject = new Map<number, Tag[]>();
    for (const row of projectTagRows) {
      const tag = tagsById.get(row.tagId);
      if (!tag) continue;
      const list = projectTagsByProject.get(row.projectId) ?? [];
      list.push(tag);
      projectTagsByProject.set(row.projectId, list);
    }

    const taskTagRows = db.select().from(schema.taskTags).all();
    const explicitTagsByTask = new Map<number, Tag[]>();
    for (const row of taskTagRows) {
      const tag = tagsById.get(row.tagId);
      if (!tag) continue;
      const list = explicitTagsByTask.get(row.taskId) ?? [];
      list.push(tag);
      explicitTagsByTask.set(row.taskId, list);
    }

    const excludedRows = db.select().from(schema.taskExcludedTags).all();
    const excludedByTask = new Map<number, number[]>();
    for (const row of excludedRows) {
      const list = excludedByTask.get(row.taskId) ?? [];
      list.push(row.tagId);
      excludedByTask.set(row.taskId, list);
    }

    const depRows = db.select().from(schema.taskDependencies).all();
    const dependenciesByTask = new Map<
      number,
      { id: number; dependsOnTaskId: number }[]
    >();
    for (const row of depRows) {
      const list = dependenciesByTask.get(row.taskId) ?? [];
      list.push({ id: row.id, dependsOnTaskId: row.dependsOnTaskId });
      dependenciesByTask.set(row.taskId, list);
    }

    const criteriaRows = db
      .select()
      .from(schema.projectAcceptanceCriteria)
      .all();
    const criteriaByProject = new Map<number, AcceptanceCriterion[]>();
    for (const row of criteriaRows) {
      const list = criteriaByProject.get(row.projectId) ?? [];
      list.push({
        id: row.id,
        projectId: row.projectId,
        text: row.text,
        checked: row.checked,
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      criteriaByProject.set(row.projectId, list);
    }
    for (const list of criteriaByProject.values()) {
      list.sort((a, b) => a.position - b.position);
    }

    const rawTasksById = new Map(rawTasks.map((t) => [t.id, t]));

    for (const p of rawProjects) {
      graph.projectsById.set(p.id, {
        id: p.id,
        title: p.title,
        status: p.status,
        ownerMemberId: p.ownerMemberId,
        context: p.context,
        dueDate: p.dueDate,
        scheduledDate: p.scheduledDate,
        position: p.position,
        tags: dedupeTags(projectTagsByProject.get(p.id) ?? []),
        acceptanceCriteria: criteriaByProject.get(p.id) ?? [],
        availableActions: availableProjectWorkflowActions(p.status),
      });
    }

    // Build a plain parent→children adjacency purely to shape the nested
    // `children` output array (sorted by sibling position); this is *not*
    // where inheritance/blocking/stuck are computed — those come from the
    // maps built above via the repo layer.
    const childrenByParentRaw = new Map<number | null, RawTask[]>();
    for (const t of rawTasks) {
      const list = childrenByParentRaw.get(t.parentTaskId) ?? [];
      list.push(t);
      childrenByParentRaw.set(t.parentTaskId, list);
    }
    for (const list of childrenByParentRaw.values()) {
      list.sort((a, b) => a.position - b.position);
    }

    const toRecord = (raw: RawTask): TaskRecord => {
      const project = raw.projectId ? graph.projectsById.get(raw.projectId) ?? null : null;
      const eff = effectiveOwnerContext.get(raw.id);
      const effectiveOwnerId = eff?.ownerId ?? null;
      const effectiveOwnerSource = eff?.ownerSource ?? "none";
      const effectiveContext = eff?.context ?? null;
      const effectiveContextSource = eff?.contextSource ?? "none";

      const explicitTags = dedupeTags(explicitTagsByTask.get(raw.id) ?? []);
      const excludedTagIds = excludedByTask.get(raw.id) ?? [];
      const effectiveTagIds = effectiveTagIdsByTask.get(raw.id) ?? [];
      const effectiveTags = dedupeTags(
        effectiveTagIds
          .map((id) => tagsById.get(id))
          .filter((t): t is Tag => t !== undefined),
      );

      const depRefs = dependenciesByTask.get(raw.id) ?? [];
      const dependencies: Dependency[] = depRefs.map((d) => {
        const dependsOn = rawTasksById.get(d.dependsOnTaskId);
        const resolved =
          dependsOn?.status === "done" || dependsOn?.status === "cancelled";
        return {
          id: d.id,
          taskId: raw.id,
          dependsOnTaskId: d.dependsOnTaskId,
          title: dependsOn?.title,
          resolved,
        };
      });
      const blocked = blockedTaskIds.has(raw.id);

      return {
        id: raw.id,
        projectId: raw.projectId,
        parentTaskId: raw.parentTaskId,
        title: raw.title,
        notes: raw.notes,
        status: raw.status,
        needsClarification: raw.needsClarification,
        ownerMemberId: raw.ownerMemberId,
        ownerInheritanceMode: raw.ownerInheritanceMode,
        createdByMemberId: raw.createdByMemberId,
        dueDate: raw.dueDate,
        scheduledDate: raw.scheduledDate,
        waitingFor: raw.waitingFor,
        context: raw.context,
        contextInheritanceMode: raw.contextInheritanceMode,
        priority: raw.priority,
        size: raw.size,
        position: raw.position,
        completedAt: raw.completedAt,
        cancelledAt: raw.cancelledAt,
        recurrenceRule: raw.recurrenceRule,
        reminderAt: raw.reminderAt,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        effectiveOwnerId,
        effectiveOwnerSource,
        effectiveContext,
        effectiveContextSource,
        effectiveTags,
        explicitTags,
        excludedTagIds,
        blocked,
        dependencies,
        children: [],
        projectTitle: project?.title ?? null,
        projectDueDate: project?.dueDate ?? null,
      };
    };

    for (const raw of rawTasks) {
      graph.tasksById.set(raw.id, toRecord(raw));
    }

    // Wire up `children` arrays and project-root lists from the already
    // built flat records (pure output shaping, no recursion into business
    // rules — every task's computed fields were already resolved above).
    for (const [parentId, rawChildren] of childrenByParentRaw) {
      const children = rawChildren.map((c) => graph.tasksById.get(c.id)!);
      graph.childrenByParent.set(parentId, children);
      if (parentId !== null) {
        const parentRecord = graph.tasksById.get(parentId);
        if (parentRecord) parentRecord.children = children;
      }
    }
    const rootTasksByProject = childrenByParentRaw.get(null) ?? [];
    const rootsByProject = new Map<number | null, TaskRecord[]>();
    for (const raw of rootTasksByProject) {
      const list = rootsByProject.get(raw.projectId) ?? [];
      list.push(graph.tasksById.get(raw.id)!);
      rootsByProject.set(raw.projectId, list);
    }
    for (const [projectId, list] of rootsByProject) {
      graph.rootsByProject.set(projectId, list);
    }

    return graph;
  }

  /** All tasks belonging to a project, flattened regardless of depth. */
  tasksForProject(projectId: number): TaskRecord[] {
    return [...this.tasksById.values()].filter((t) => t.projectId === projectId);
  }

  /** Every task in the graph, flattened. */
  allTasks(): TaskRecord[] {
    return [...this.tasksById.values()];
  }

  nextActionFor(projectId: number): TaskRecord | null {
    const id = this.nextActionIdByProject.get(projectId);
    if (id === undefined) return null;
    return this.tasksById.get(id) ?? null;
  }

  stuckReasonFor(projectId: number): StuckReason | null {
    return this.stuckReasonByProject.get(projectId) ?? null;
  }

  projectWithComputed(projectId: number): ProjectRecord | null {
    const project = this.projectsById.get(projectId);
    if (!project) return null;
    const tasks = this.tasksForProject(projectId);
    const openCount = tasks.filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    ).length;
    const doneCount = tasks.filter((t) => t.status === "done").length;
    return {
      ...project,
      openCount,
      doneCount,
      nextAction: this.nextActionFor(projectId),
      stuckReason: this.stuckReasonFor(projectId),
    };
  }

  listProjectsWithComputed(): ProjectRecord[] {
    return [...this.projectsById.keys()]
      .map((id) => this.projectWithComputed(id)!)
      .sort((a, b) => a.position - b.position);
  }

  listStuckProjects(): StuckProjectRecord[] {
    const result: StuckProjectRecord[] = [];
    for (const project of this.listProjectsWithComputed()) {
      if (project.status !== "active") continue;
      const reason = project.stuckReason;
      if (!reason) continue;
      result.push({
        ...project,
        stuckReason: reason,
        repairAction:
          reason === "no_next_action" &&
          this.tasksForProject(project.id).some(
            (task) =>
              task.needsClarification &&
              task.status !== "done" &&
              task.status !== "cancelled",
          )
            ? "Kläre die erfassten Aufgaben und lege danach einen machbaren nächsten Schritt fest."
            : repairActionByReason[reason],
      });
    }
    return result;
  }

  /** Top-level tasks (no project) for the Eingang / inbox view. */
  rootTasksWithoutProject(): TaskRecord[] {
    return this.rootsByProject.get(null) ?? [];
  }
}

export function labelForStuckReason(reason: StuckReason): string {
  return stuckReasonLabels[reason];
}

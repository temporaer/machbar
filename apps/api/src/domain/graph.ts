import type {
  AcceptanceCriterion,
  Dependency,
  InheritanceMode,
  Project as SharedProject,
  ProjectActivationReadiness,
  ProjectStatus,
  StuckReason,
  Tag,
  Task as SharedTask,
  TaskSize,
  TaskStatus,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  availableProjectWorkflowActions,
  type ProjectWorkflowAction,
} from "./mutations.js";
import {
  getEffectiveOwners,
  getEffectiveTagIds,
} from "../repo/effectiveRepo.js";
import { getNextActionTaskIdsByProject } from "../repo/nextActionRepo.js";
import { selectPrimaryAreaTag } from "./projectAreas.js";
import { performance } from "node:perf_hooks";
import { recordGraphLoad } from "../diagnostics/graphMetrics.js";
import {
  analyzeTaskBlockers,
  type BlockerPathDiagnosis,
  type TaskBlockerAnalysis,
} from "./blockers.js";
import { evaluateProjectActivationReadiness } from "./projectReadiness.js";

export interface ProjectRecord extends SharedProject {
  /** Workflow actions currently legal for this project's status (see
   * `availableProjectWorkflowActions` in `domain/mutations.ts`); not part
   * of the shared `Project` contract, purely an API-response convenience. */
  availableActions: ProjectWorkflowAction[];
  activationReadiness: ProjectActivationReadiness;
}

export interface TaskRecord extends SharedTask {}

export interface StuckProjectRecord extends ProjectRecord {
  stuckReason: StuckReason;
}

function dedupeTags(tags: Tag[]): Tag[] {
  const seen = new Map<number, Tag>();
  for (const tag of tags) {
    if (!seen.has(tag.id)) seen.set(tag.id, tag);
  }
  return [...seen.values()];
}

interface RawTask {
  id: number;
  revision: number;
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
  priority: number | null;
  size: TaskSize | null;
  position: number;
  completedAt: string | null;
  cancelledAt: string | null;
  repeatAfterDays: number | null;
  allowedDeviationDays: number | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

interface RawProject {
  id: number;
  revision: number;
  title: string;
  notes: string;
  status: ProjectStatus;
  ownerMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

function stuckReasonForDiagnoses(
  diagnoses: BlockerPathDiagnosis[],
): StuckReason | null {
  if (
    diagnoses.some(
      (diagnosis) => diagnosis.reason === "waiting_without_followup",
    )
  ) {
    return "waiting_without_followup";
  }
  if (
    diagnoses.some((diagnosis) => diagnosis.reason !== "followup_due")
  ) {
    return "blocked_without_clear_path";
  }
  if (diagnoses.length > 0) return null;
  return "no_next_action";
}

/**
 * Assembles the fully computed project/task shapes described by
 * @machbar/shared for API responses.
 *
 * `Graph` is deliberately a thin *service/repository-composition* layer: it
 * issues a handful of ordinary Drizzle CRUD selects for the raw rows, and
 * delegates every non-trivial derivation — effective owner/tags
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
  readonly tasksByProject = new Map<number | null, TaskRecord[]>();
  readonly childrenByParent = new Map<number | null, TaskRecord[]>();
  readonly rootsByProject = new Map<number | null, TaskRecord[]>();
  private readonly stuckReasonByProject: Map<number, StuckReason>;
  private readonly nextActionIdsByProject: Map<number, number[]>;
  private readonly blockerAnalysisByTask = new Map<
    number,
    TaskBlockerAnalysis
  >();
  private readonly activationReadinessByProject = new Map<
    number,
    ProjectActivationReadiness
  >();

  private constructor(
    stuckReasonByProject: Map<number, StuckReason>,
    nextActionIdsByProject: Map<number, number[]>,
  ) {
    this.stuckReasonByProject = stuckReasonByProject;
    this.nextActionIdsByProject = nextActionIdsByProject;
  }

  static load(
    db: Db,
    today = new Date().toISOString().slice(0, 10),
  ): Graph {
    const startedAt = performance.now();
    // --- SQL/CTE-computed derivations (repo layer) ---------------------
    const effectiveOwners = getEffectiveOwners(db);
    const effectiveTagIdsByTask = getEffectiveTagIds(db);
    const nextActionIdsByProject = getNextActionTaskIdsByProject(db);
    const graph = new Graph(new Map(), nextActionIdsByProject);

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
    const externalWaitRows = db.select().from(schema.taskExternalWaits).all();
    const externalWaitByTask = new Map(
      externalWaitRows
        .filter((row) => Boolean(row.waitingFor?.trim()))
        .map((row) => [
          row.taskId,
          {
            waitingFor: row.waitingFor?.trim() ?? null,
            revisitDate: row.revisitDate,
          },
        ]),
    );

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
    const projectStatuses = new Map(
      rawProjects.map((project) => [project.id, project.status]),
    );
    const blockerInputs = new Map(
      rawTasks.map((task) => [
        task.id,
        {
          id: task.id,
          title: task.title,
          status: task.status,
          projectId: task.projectId,
          scheduledDate: task.scheduledDate,
          externalWait: externalWaitByTask.get(task.id) ?? null,
          dependencies: (dependenciesByTask.get(task.id) ?? []).map(
            (dependency) => {
              const prerequisite = rawTasksById.get(
                dependency.dependsOnTaskId,
              );
              return {
                dependsOnTaskId: dependency.dependsOnTaskId,
                resolved:
                  prerequisite?.status === "done" ||
                  prerequisite?.status === "cancelled",
              };
            },
          ),
        },
      ]),
    );
    const blockerAnalysis = analyzeTaskBlockers(
      blockerInputs,
      projectStatuses,
      today,
    );
    for (const [taskId, analysis] of blockerAnalysis) {
      graph.blockerAnalysisByTask.set(taskId, analysis);
    }
    for (const project of rawProjects) {
      const activationStatuses = new Map(projectStatuses);
      activationStatuses.set(project.id, "active");
      const activationBlockers =
        project.status === "active"
          ? blockerAnalysis
          : analyzeTaskBlockers(blockerInputs, activationStatuses, today);
      graph.activationReadinessByProject.set(
        project.id,
        evaluateProjectActivationReadiness({
          ownerMemberId: project.ownerMemberId,
          candidateTaskIds: nextActionIdsByProject.get(project.id) ?? [],
          projectTaskIds: rawTasks
            .filter((task) => task.projectId === project.id)
            .map((task) => task.id),
          blockerAnalysisByTask: activationBlockers,
          today,
        }),
      );
    }

    for (const p of rawProjects) {
      graph.projectsById.set(p.id, {
        id: p.id,
        revision: p.revision,
        title: p.title,
        notes: p.notes,
        status: p.status,
        ownerMemberId: p.ownerMemberId,
        dueDate: p.dueDate,
        scheduledDate: p.scheduledDate,
        position: p.position,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        reviewedAt: p.reviewedAt,
        tags: dedupeTags(projectTagsByProject.get(p.id) ?? []),
        effectiveTags: dedupeTags(projectTagsByProject.get(p.id) ?? []),
        effectiveAreaTags: dedupeTags(
          projectTagsByProject
            .get(p.id)
            ?.filter((tag) => tag.kind === "area") ?? [],
        ),
        primaryAreaTag: null,
        acceptanceCriteria: criteriaByProject.get(p.id) ?? [],
        availableActions: availableProjectWorkflowActions(p.status),
        activationReadiness: graph.activationReadinessByProject.get(p.id)!,
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
      const eff = effectiveOwners.get(raw.id);
      const effectiveOwnerId = eff?.ownerId ?? null;
      const effectiveOwnerSource = eff?.ownerSource ?? "none";
      const inheritedOwnerId =
        raw.parentTaskId !== null
          ? effectiveOwners.get(raw.parentTaskId)?.ownerId ?? null
          : project?.ownerMemberId ?? null;

      const explicitTags = dedupeTags(explicitTagsByTask.get(raw.id) ?? []);
      const excludedTagIds = excludedByTask.get(raw.id) ?? [];
      const effectiveTagIds = effectiveTagIdsByTask.get(raw.id) ?? [];
      const effectiveTags = dedupeTags(
        effectiveTagIds
          .map((id) => tagsById.get(id))
          .filter((t): t is Tag => t !== undefined),
      );
      const effectiveAreaTags = effectiveTags.filter(
        (tag) => tag.kind === "area",
      );
      const effectiveActorTags = effectiveTags.filter(
        (tag) => tag.kind === "actor",
      );
      const effectiveContextTags = effectiveTags.filter(
        (tag) => tag.kind === "context",
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
      const execution = blockerAnalysis.get(raw.id);
      const externalWait = externalWaitByTask.get(raw.id) ?? null;
      const blockers = [
        ...(externalWait
          ? [
              {
                type: "external" as const,
                waitingFor: externalWait.waitingFor,
              },
            ]
          : []),
        ...dependencies
          .filter((dependency) => !dependency.resolved)
          .map((dependency) => {
            const prerequisite = rawTasksById.get(dependency.dependsOnTaskId);
            return {
              type: "dependency" as const,
              taskId: dependency.dependsOnTaskId,
              title: dependency.title,
              scheduledDate: prerequisite?.scheduledDate ?? null,
              resolved: false,
            };
          }),
      ];

      return {
        id: raw.id,
        revision: raw.revision,
        projectId: raw.projectId,
        parentTaskId: raw.parentTaskId,
        title: raw.title,
        notes: raw.notes,
        status: raw.status,
        needsClarification: raw.status === "captured",
        ownerMemberId: raw.ownerMemberId,
        ownerInheritanceMode: raw.ownerInheritanceMode,
        createdByMemberId: raw.createdByMemberId,
        dueDate: raw.dueDate,
        scheduledDate: raw.scheduledDate,
        externalWait,
        priority: raw.priority,
        size: raw.size,
        position: raw.position,
        completedAt: raw.completedAt,
        cancelledAt: raw.cancelledAt,
        repeatAfterDays: raw.repeatAfterDays,
        allowedDeviationDays: raw.allowedDeviationDays,
        reminderAt: raw.reminderAt,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        reviewedAt: raw.reviewedAt,
        effectiveOwnerId,
        effectiveOwnerSource,
        inheritedOwnerId,
        effectiveTags,
        effectiveAreaTags,
        effectiveActorTags,
        effectiveContextTags,
        explicitTags,
        excludedTagIds,
        blocked: execution?.blocked ?? false,
        executable: execution?.executable ?? false,
        nextBlockerAttentionDate:
          execution?.nextBlockerAttentionDate ?? null,
        blockers,
        dependencies,
        children: [],
        projectTitle: project?.title ?? null,
        projectOwnerMemberId: project?.ownerMemberId ?? null,
        projectDueDate: project?.dueDate ?? null,
      };
    };

    for (const raw of rawTasks) {
      const task = toRecord(raw);
      graph.tasksById.set(raw.id, task);
      const projectTasks = graph.tasksByProject.get(task.projectId) ?? [];
      projectTasks.push(task);
      graph.tasksByProject.set(task.projectId, projectTasks);
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

    for (const project of graph.projectsById.values()) {
      if (project.status !== "active") continue;
      const tasks = graph.tasksForProject(project.id);
      const openTasks = tasks.filter(
        (task) => task.status !== "done" && task.status !== "cancelled",
      );
      let reason: StuckReason | null = null;
      if (tasks.length === 0) {
        reason = "no_next_action";
      } else if (openTasks.length === 0) {
        reason = "completion_review";
      } else {
        const blockedDiagnoses = openTasks
          .filter((task) => task.blocked)
          .flatMap(
            (task) => blockerAnalysis.get(task.id)?.diagnoses ?? [],
          );
        const hasHealthyPath = openTasks.some((task) => {
          const analysis = blockerAnalysis.get(task.id);
          return (
            task.status === "actionable" &&
            (analysis?.executable || analysis?.healthyProgressPath)
          );
        });
        if (!hasHealthyPath) {
          reason = stuckReasonForDiagnoses(blockedDiagnoses);
        } else if (
          openTasks.some(
            (task) =>
              task.status === "actionable" && task.effectiveOwnerId === null,
          )
        ) {
          reason = "unassigned_actionable";
        }
      }
      if (reason) graph.stuckReasonByProject.set(project.id, reason);
    }

    recordGraphLoad(
      performance.now() - startedAt,
      graph.tasksById.size,
      graph.projectsById.size,
    );
    return graph;
  }

  /** All tasks belonging to a project, flattened regardless of depth. */
  tasksForProject(projectId: number): TaskRecord[] {
    return this.tasksByProject.get(projectId) ?? [];
  }

  /** Every task in the graph, flattened. */
  allTasks(): TaskRecord[] {
    return [...this.tasksById.values()];
  }

  nextActionFor(projectId: number): TaskRecord | null {
    const id = this.nextActionIdsByProject.get(projectId)?.[0];
    if (id === undefined) return null;
    return this.tasksById.get(id) ?? null;
  }

  nextActionCandidatesFor(projectId: number): TaskRecord[] {
    return (this.nextActionIdsByProject.get(projectId) ?? [])
      .map((id) => this.tasksById.get(id))
      .filter((task): task is TaskRecord => task !== undefined);
  }

  todayNextActionsFor(
    projectId: number,
    selection:
      | { scope: "mine"; memberId: number }
      | { scope: "all" },
  ): TaskRecord[] {
    const candidates = this.nextActionCandidatesFor(projectId);
    if (selection.scope === "mine") {
      const selected = candidates.find(
        (task) =>
          task.effectiveOwnerId === selection.memberId ||
          task.effectiveOwnerId === null,
      );
      return selected ? [selected] : [];
    }

    const seenLanes = new Set<number | null>();
    return candidates.filter((task) => {
      if (seenLanes.has(task.effectiveOwnerId)) return false;
      seenLanes.add(task.effectiveOwnerId);
      return true;
    });
  }

  stuckReasonFor(projectId: number): StuckReason | null {
    return this.stuckReasonByProject.get(projectId) ?? null;
  }

  blockerAnalysisFor(taskId: number): TaskBlockerAnalysis | null {
    return this.blockerAnalysisByTask.get(taskId) ?? null;
  }

  projectWithComputed(projectId: number): ProjectRecord | null {
    const project = this.projectsById.get(projectId);
    if (!project) return null;
    const tasks = this.tasksForProject(projectId);
    const openCount = tasks.filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    ).length;
    const doneCount = tasks.filter((t) => t.status === "done").length;
    const waitingOn = [
      ...new Set(
        tasks
          .filter((task) => task.externalWait !== null)
          .sort(
            (a, b) =>
              a.position - b.position ||
              a.title.localeCompare(b.title, "de") ||
              a.id - b.id,
          )
          .map(
            (task) =>
              task.externalWait?.waitingFor?.trim() || task.title,
          ),
      ),
    ];
    const waitingUntil =
      tasks
          .map((task) => task.externalWait?.revisitDate ?? null)
          .filter((date): date is string => date !== null)
          .sort()[0] ?? null;
    const effectiveTags = dedupeTags([
      ...project.tags,
      ...tasks.flatMap((task) => task.effectiveTags),
    ]);
    const effectiveAreaTags = effectiveTags.filter(
      (tag) => tag.kind === "area",
    );
    return {
      ...project,
      effectiveTags,
      effectiveAreaTags,
      primaryAreaTag: selectPrimaryAreaTag(project.tags, effectiveTags, tasks),
      openCount,
      doneCount,
      nextAction: this.nextActionFor(projectId),
      stuckReason: this.stuckReasonFor(projectId),
      waitingOn,
      waitingUntil,
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
      });
    }
    return result;
  }

  /** Top-level tasks (no project) for the Eingang / inbox view. */
  rootTasksWithoutProject(): TaskRecord[] {
    return this.rootsByProject.get(null) ?? [];
  }
}

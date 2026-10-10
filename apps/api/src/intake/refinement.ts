import { and, eq } from "drizzle-orm";
import type { WorkRefinementProposal } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { updateTask, createChildTask, createTask } from "../domain/taskCrud.js";
import { updateProject } from "../domain/storyCrud.js";
import { addCriterion, updateCriterionText } from "../domain/storyCapabilities.js";
import { moveTask } from "../domain/structuralMoves.js";
import { addDependency, upsertExternalWait } from "../domain/taskCapabilities.js";
import {
  beginCommitmentConversion,
  finishCommitmentConversion,
} from "./commitmentPreservingConversion.js";
import type { MutationContext } from "../domain/workItemShared.js";
import { nowIso } from "../domain/workItemShared.js";
import { workRefinementProposalSchema } from "@machbar/shared";

function idsFromSnapshot(snapshot: unknown, result = new Map<number, number>()): Map<number, number> {
  if (!snapshot || typeof snapshot !== "object") return result;
  const item = snapshot as Record<string, unknown>;
  if (typeof item.id === "number" && typeof item.revision === "number") result.set(item.id, item.revision);
  for (const key of ["children", "tasks", "projects"]) if (Array.isArray(item[key])) for (const child of item[key] as unknown[]) idsFromSnapshot(child, result);
  return result;
}

export function assertRefinementContext(proposal: WorkRefinementProposal, targetType: "task" | "project", targetId: number, snapshot: unknown, acceptedOnly = false, db?: Db): void {
  const nodes = new Map<number, Record<string, unknown>>();
  const collect = (value: unknown, role?: "task" | "project") => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const nodeRole = role ?? (Array.isArray(node.tasks) || Array.isArray(node.projects) ? "project" : "task");
    if (typeof node.id === "number") nodes.set(node.id, { ...node, _role: nodeRole });
    for (const child of Array.isArray(node.children) ? node.children : []) collect(child, "task");
    for (const child of Array.isArray(node.tasks) ? node.tasks : []) collect(child, "task");
    for (const child of Array.isArray(node.projects) ? node.projects : []) collect(child, "project");
  };
  collect(snapshot, targetType);
  const convertTargets = new Set<number>();
  for (const change of proposal.changes) if (change.kind === "convert_task_to_project" && (!acceptedOnly || change.accepted)) convertTargets.add(change.targetId);
  const node = (id: number) => {
    const value = nodes.get(id);
    if (!value) throw AppError.badRequest("intake_plan_invalid", "A recommendation references work outside the supplied context.");
    return value;
  };
  for (const change of proposal.changes) {
    if (acceptedOnly && !change.accepted) continue;
    switch (change.kind) {
      case "update_task": if (node(change.targetId)._role !== "task") throw AppError.badRequest("intake_plan_invalid", "A task edit references a project."); break;
      case "update_project": if (node(change.targetId)._role !== "project") throw AppError.badRequest("intake_plan_invalid", "A project edit references a task."); break;
      case "convert_task_to_project": {
        const item = node(change.targetId);
        const hasRecurrenceHistory = db?.select({ id: schema.taskRecurrenceOccurrences.id }).from(schema.taskRecurrenceOccurrences).where(eq(schema.taskRecurrenceOccurrences.taskId, change.targetId)).get() !== undefined;
        if (change.targetId !== targetId || item._role !== "task" || item.kind === "reference" || item.parentTaskId != null || item.projectId != null || !["captured", "actionable", "someday"].includes(String(item.status)) || item.externalWait != null || (Array.isArray(item.dependencies) && item.dependencies.length > 0) || (Array.isArray(item.reminders) && item.reminders.length > 0) || item.repeatAfterDays != null || hasRecurrenceHistory) {
          throw AppError.badRequest("intake_plan_invalid", "The proposed project conversion violates known task structure restrictions.");
        }
        break;
      }
      case "create_child": {
        const parent = node(change.parentTaskId);
        const isProject = parent._role === "project" || (parent._role === "task" && convertTargets.has(change.parentTaskId));
        if (parent._role === "project" && ["completed", "archived"].includes(String(parent.status))) throw AppError.badRequest("intake_plan_invalid", "New work cannot be proposed under a completed or archived project.");
        if (parent._role === "task" && parent.status === "captured" && !convertTargets.has(change.parentTaskId)) {
          throw AppError.badRequest("intake_plan_invalid", "Adding a step to a captured task requires accepting its project conversion.");
        }
        if (parent._role === "task" && parent.repeatAfterDays != null) throw AppError.badRequest("intake_plan_invalid", "Recurring tasks cannot receive child steps.");
        if (!isProject && (parent._role !== "task" || parent.kind === "reference" || ["captured", "done", "cancelled"].includes(String(parent.status)))) {
          throw AppError.badRequest("intake_plan_invalid", "The proposed child action has a structurally incompatible parent.");
        }
        break;
      }
      case "move_task": {
        const task = node(change.targetId);
        if (task._role !== "task" || (change.parentTaskId !== null && node(change.parentTaskId)._role !== "task") || (change.projectId !== null && node(change.projectId)._role !== "project")) throw AppError.badRequest("intake_plan_invalid", "The proposed task move has an incompatible target.");
        if (["done", "cancelled"].includes(String(task.status))) throw AppError.badRequest("intake_plan_invalid", "Completed or cancelled tasks cannot be moved by a refinement proposal.");
        if (change.projectId !== null && node(change.projectId).scope !== task.scope) throw AppError.badRequest("intake_plan_invalid", "A task cannot be moved across household/work scope.");
        if (change.parentTaskId === change.targetId) throw AppError.badRequest("intake_plan_invalid", "A task cannot be moved under itself.");
        if (change.parentTaskId !== null) {
          let ancestor = node(change.parentTaskId);
          if (ancestor.scope !== task.scope || (ancestor.projectId ?? null) !== change.projectId) throw AppError.badRequest("intake_plan_invalid", "The proposed parent and project destination do not match.");
          if (ancestor.repeatAfterDays != null) throw AppError.badRequest("intake_plan_invalid", "Recurring tasks cannot contain subtasks.");
          const visited = new Set<number>();
          while (true) {
            if (ancestor.id === change.targetId || visited.has(Number(ancestor.id))) throw AppError.badRequest("intake_plan_invalid", "The proposed move would create a hierarchy cycle.");
            visited.add(Number(ancestor.id));
            if (ancestor.parentTaskId == null) break;
            ancestor = node(Number(ancestor.parentTaskId));
          }
        }
        if (change.projectId !== null && ["completed", "archived"].includes(String(node(change.projectId).status))) throw AppError.badRequest("intake_plan_invalid", "Tasks cannot be moved into a completed or archived project.");
        break;
      }
      case "add_dependency":
        if (node(change.taskId)._role !== "task" || node(change.dependsOnTaskId)._role !== "task") throw AppError.badRequest("intake_plan_invalid", "A dependency must reference two existing tasks.");
        if (change.taskId === change.dependsOnTaskId) throw AppError.badRequest("intake_plan_invalid", "A task cannot depend on itself.");
        if (node(change.taskId).scope !== node(change.dependsOnTaskId).scope) throw AppError.badRequest("intake_plan_invalid", "A dependency cannot cross household/work scope.");
        break;
      case "update_wait":
        if (node(change.taskId)._role !== "task" || node(change.taskId).status !== "actionable") throw AppError.badRequest("intake_plan_invalid", "Waiting details can only be updated for actionable tasks.");
        if (node(change.taskId).repeatAfterDays != null) throw AppError.badRequest("intake_plan_invalid", "Recurring tasks cannot use external waits.");
        break;
      case "update_project_outcome": {
        const project = node(change.projectId);
        if (project._role !== "project" || (change.criterionId !== undefined && !(Array.isArray(project.outcome) && project.outcome.some((criterion) => typeof criterion === "object" && criterion !== null && (criterion as { id?: unknown }).id === change.criterionId)))) throw AppError.badRequest("intake_plan_invalid", "A project outcome references an unknown criterion.");
        if (change.criterionId === undefined && Array.isArray(project.outcome) && project.outcome.some((criterion) => typeof criterion === "object" && criterion !== null && typeof (criterion as { text?: unknown }).text === "string" && (criterion as { text: string }).text.trim() === change.outcome.trim())) throw AppError.badRequest("intake_plan_invalid", "The suggested project outcome already exists.");
        break;
      }
      case "advisory": change.affectedIds.forEach((id) => node(id)); break;
    }
  }
}

function assertFresh(db: Db, job: typeof schema.intakeJobs.$inferSelect, viewerId: number | null) {
  const graph = Graph.load(db, undefined, viewerId ?? undefined);
  const type = job.refinementTargetType;
  const targetId = job.refinementTargetId;
  if (!type || targetId === null || !job.refinementSnapshotJson) throw AppError.conflict("stale_write_conflict", "The refinement context is unavailable.");
  const snapshot = JSON.parse(job.refinementSnapshotJson) as unknown;
  const expected = idsFromSnapshot(snapshot);
  if (type === "task") {
    const task = graph.tasksById.get(targetId);
    if (!task) throw AppError.notFound("task_not_found", "The task is no longer available.");
    const current = new Map<number, number>();
    const collect = (node: typeof task) => { current.set(node.id, node.revision); node.children.forEach(collect); };
    collect(task);
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...current].sort())) throw AppError.conflict("stale_write_conflict", "The task or its outline changed. Generate a fresh refinement.");
  } else {
    const project = graph.projectsById.get(targetId);
    if (!project) throw AppError.notFound("project_not_found", "The project is no longer available.");
    const current = new Map<number, number>();
    const collectProject = (item: typeof project) => {
      current.set(item.id, item.revision);
      for (const task of graph.tasksByProject.get(item.id) ?? []) current.set(task.id, task.revision);
      item.childStories.forEach(collectProject);
    };
    collectProject(project);
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...current].sort())) throw AppError.conflict("stale_write_conflict", "The project or its outline changed. Generate a fresh refinement.");
  }
  return { allowed: new Set(expected.keys()), snapshot };
}

export function updateWorkRefinement(db: Db, id: string, viewerId: number | null, expectedRevision: number, value: unknown) {
  const job = db.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
  if (!job || job.createdByMemberId !== viewerId || job.refinementTargetType === null) throw AppError.notFound("intake_not_found", "The refinement was not found.");
  if (!(["ready", "analysis_failed"].includes(job.status)) || job.revision !== expectedRevision || (job.status === "analysis_failed" && !job.refinementJson)) throw AppError.conflict("stale_write_conflict", "The proposal changed. Reload it before saving.");
  const proposal = workRefinementProposalSchema.parse(value);
  if (proposal.intent !== job.refinementIntent) throw AppError.badRequest("intake_draft_invalid", "The refinement intent cannot be changed.");
  assertRefinementContext(proposal, job.refinementTargetType, job.refinementTargetId!, JSON.parse(job.refinementSnapshotJson ?? "null"), false, db);
  const result = db.update(schema.intakeJobs).set({ refinementJson: JSON.stringify(proposal), status: "ready", errorJson: null, revision: job.revision + 1, updatedAt: nowIso() })
    .where(and(eq(schema.intakeJobs.id, id), eq(schema.intakeJobs.revision, expectedRevision), eq(schema.intakeJobs.status, job.status))).run();
  if (result.changes !== 1) throw AppError.conflict("stale_write_conflict", "The proposal changed. Reload it before saving.");
}

export function applyWorkRefinement(
  db: Db,
  id: string,
  viewerId: number | null,
  expectedRevision: number,
  context: MutationContext,
  projectDriverMemberId?: number,
) {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const job = tx.select().from(schema.intakeJobs).where(eq(schema.intakeJobs.id, id)).get();
    if (!job || job.createdByMemberId !== viewerId || job.refinementTargetType === null) throw AppError.notFound("intake_not_found", "The refinement was not found.");
    if (job.status !== "ready" || job.revision !== expectedRevision || !job.refinementJson) throw AppError.conflict("stale_write_conflict", "The proposal changed. Reload it before applying.");
    const proposal = workRefinementProposalSchema.parse(JSON.parse(job.refinementJson));
    const { allowed, snapshot } = assertFresh(txDb, job, viewerId);
    assertRefinementContext(proposal, job.refinementTargetType, job.refinementTargetId!, snapshot, true, txDb);
    const changes = proposal.changes.filter((change) => change.accepted);
    if (changes.some((change) => change.kind === "advisory")) throw AppError.badRequest("intake_draft_invalid", "Advisory recommendations require manual resolution.");
    // Validate the selected set as a whole before making any domain mutation.
    // In particular, a captured-task child depends on its explicit conversion.
    assertRefinementContext({ ...proposal, changes }, job.refinementTargetType, job.refinementTargetId!, snapshot, true, txDb);
    const priority: Record<string, number> = { convert_task_to_project: 0, update_task: 1, update_project: 1, create_child: 2, move_task: 3, add_dependency: 4, update_wait: 5, update_project_outcome: 6, advisory: 7 };
    const orderedChanges = [...changes].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99));
    const changedRoleIds = new Set<number>();
    const conversions = new Map<number, ReturnType<typeof beginCommitmentConversion>>();
    const fieldWrites = new Map<string, string>();
    for (const change of orderedChanges) {
      if (change.kind === "convert_task_to_project") changedRoleIds.add(change.targetId);
      if ((change.kind === "update_task" || change.kind === "update_project") && changedRoleIds.has(change.targetId)) {
        throw AppError.badRequest("intake_draft_invalid", "A role conversion cannot be combined with an edit to the same item.");
      }
      const writes: Array<[number, string, unknown]> = [];
      if (change.kind === "update_task" || change.kind === "update_project") {
        for (const field of ["title", "notes"] as const) if (change[field] !== undefined) writes.push([change.targetId, field, change[field]]);
      } else if (change.kind === "convert_task_to_project") writes.push([change.targetId, "role", "project"]);
      else if (change.kind === "move_task") {
        writes.push([change.targetId, "move", JSON.stringify([change.parentTaskId, change.projectId, change.position])]);
      } else if (change.kind === "update_wait") {
        writes.push([change.taskId, "waitingFor", change.waitingFor], [change.taskId, "revisitAt", change.revisitAt]);
      } else if (change.kind === "update_project_outcome") {
        writes.push([change.projectId, `outcome:${change.criterionId ?? "new"}`, change.outcome]);
      }
      for (const [entityId, field, value] of writes) {
        const key = `${entityId}:${field}`;
        const encoded = JSON.stringify(value) ?? "__undefined__";
        const previous = fieldWrites.get(key);
        if (previous !== undefined && previous !== encoded) throw AppError.badRequest("intake_draft_invalid", "The selected changes contain conflicting edits to the same item.");
        fieldWrites.set(key, encoded);
      }
    }
    const dependencyEdges = txDb.select().from(schema.taskDependencies).all();
    const dependencies = new Map<number, Set<number>>();
    for (const edge of dependencyEdges) {
      const targets = dependencies.get(edge.taskId) ?? new Set<number>();
      targets.add(edge.dependsOnTaskId);
      dependencies.set(edge.taskId, targets);
    }
    const reaches = (start: number, target: number) => {
      const pending = [start];
      const visited = new Set<number>();
      while (pending.length) {
        const current = pending.pop()!;
        if (current === target) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(dependencies.get(current) ?? []));
      }
      return false;
    };
    for (const change of orderedChanges) {
      if (change.kind !== "add_dependency") continue;
      if (reaches(change.dependsOnTaskId, change.taskId)) throw AppError.badRequest("intake_draft_invalid", "The selected dependencies would create a cycle.");
      const targets = dependencies.get(change.taskId) ?? new Set<number>();
      targets.add(change.dependsOnTaskId);
      dependencies.set(change.taskId, targets);
    }
    const ensure = (...ids: number[]) => { if (ids.some((target) => !allowed.has(target))) throw AppError.badRequest("intake_draft_invalid", "A proposed change targets work outside this refinement context."); };
    for (const change of orderedChanges) {
      switch (change.kind) {
        case "update_task": {
          ensure(change.targetId);
          const task = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.targetId)).get();
          if (!task || task.role !== "task") throw AppError.badRequest("intake_draft_invalid", "Invalid task target.");
          updateTask(txDb, task.id, { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.notes !== undefined ? { notes: change.notes ?? "" } : {}), expectedRevision: task.revision }, context); break;
        }
        case "update_project": {
          ensure(change.targetId);
          const project = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.targetId)).get();
          if (!project || project.role !== "story") throw AppError.badRequest("intake_draft_invalid", "Invalid project target.");
          updateProject(txDb, project.id, { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.notes !== undefined ? { notes: change.notes ?? "" } : {}), expectedRevision: project.revision }, context); break;
        }
        case "convert_task_to_project": {
          ensure(change.targetId);
          const task = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.targetId)).get();
          if (!task || task.role !== "task") throw AppError.badRequest("intake_draft_invalid", "Invalid task conversion target.");
          conversions.set(
            task.id,
            beginCommitmentConversion(txDb, task.id, projectDriverMemberId, viewerId, context),
          );
          break;
        }
        case "create_child": {
          ensure(change.parentTaskId);
          const parent = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.parentTaskId)).get();
          if (!parent) throw AppError.badRequest("intake_draft_invalid", "Invalid child parent.");
          const input = { title: change.title, notes: change.notes ?? "", createdByMemberId: job.createdByMemberId };
          if (parent.role === "story") createTask(txDb, { ...input, projectId: parent.id }, context);
          else createChildTask(txDb, parent.id, input, context);
          break;
        }
        case "move_task": {
          ensure(change.targetId);
          if (change.parentTaskId !== null) ensure(change.parentTaskId);
          if (change.projectId !== null) ensure(change.projectId);
          const task = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.targetId)).get();
          if (!task || task.role !== "task") throw AppError.badRequest("intake_draft_invalid", "Invalid task move target.");
          moveTask(txDb, task.id, { parentTaskId: change.parentTaskId, projectId: change.projectId, position: change.position, expectedRevision: task.revision }, context); break;
        }
        case "add_dependency": {
          ensure(change.taskId, change.dependsOnTaskId); addDependency(txDb, change.taskId, change.dependsOnTaskId, context); break;
        }
        case "update_wait": {
          ensure(change.taskId);
          const task = txDb.select().from(schema.workItems).where(eq(schema.workItems.id, change.taskId)).get();
          if (!task || task.role !== "task") throw AppError.badRequest("intake_draft_invalid", "Invalid waiting task.");
          upsertExternalWait(txDb, task.id, { waitingFor: change.waitingFor, ...(change.revisitAt !== undefined ? { revisitAt: change.revisitAt } : {}), expectedRevision: task.revision }, context); break;
        }
        case "update_project_outcome": {
          ensure(change.projectId);
          if (change.criterionId !== undefined) updateCriterionText(txDb, change.projectId, change.criterionId, change.outcome, context);
          else addCriterion(txDb, change.projectId, change.outcome, context);
          break;
        }
        case "advisory": break;
      }
    }
    for (const conversion of conversions.values()) {
      const current = txDb.select({ revision: schema.workItems.revision }).from(schema.workItems)
        .where(eq(schema.workItems.id, conversion.projectId)).get();
      finishCommitmentConversion(txDb, {
        ...conversion,
        projectRevision: current?.revision ?? conversion.projectRevision,
      }, context);
    }
    const updated = tx.update(schema.intakeJobs).set({ status: "applied", revision: job.revision + 1, updatedAt: nowIso(), applyResultsJson: JSON.stringify({ work: [], calendar: [], paperlessDocumentIds: [] }) })
      .where(and(eq(schema.intakeJobs.id, id), eq(schema.intakeJobs.revision, expectedRevision), eq(schema.intakeJobs.status, "ready"))).run();
    if (updated.changes !== 1) throw AppError.conflict("stale_write_conflict", "The proposal changed while applying.");
    return { appliedChangeCount: changes.length };
  });
}

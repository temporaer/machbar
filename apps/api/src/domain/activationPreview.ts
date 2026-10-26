import type { ActivationPreview, ProjectActivationDecisionSnapshot } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { Graph } from "./graph.js";
import { AppError } from "../errors.js";

class PreviewRollback {
  constructor(readonly result: ActivationPreview) {}
}

/** Reuse the canonical mutation, including its proposed graph, in a rollback-only
 * transaction. No preview writes, activity, points or generated IDs survive. */
export function previewActivation(db: Db, mutate: () => unknown, viewerMemberId: number | undefined, sourceIds: Array<number | null | undefined>): ActivationPreview {
  try {
    db.transaction(() => {
      const visible = Graph.load(db, undefined, viewerMemberId);
      const authorize = (id: number) => {
        if (!visible.tasksById.has(id) && !visible.projectsById.has(id)) {
          throw AppError.notFound("task_not_found", "Work item not found");
        }
      };
      for (const id of sourceIds) if (id != null) authorize(id);
      const before = new Map(db.select().from(schema.workItems).all().map(row => [row.id, row]));
      try {
        mutate();
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "project_commitment_resolution_required") throw error;
        if (!Array.isArray(error.details?.projects) || !Array.isArray(error.details?.expectedProjects)) throw error;
        const decision = error.details as unknown as ProjectActivationDecisionSnapshot;
        for (const entry of [...decision.expectedProjects, ...decision.projects]) authorize(entry.projectId);
        throw new PreviewRollback({ decision, activatingProjects: decision.expectedProjects.map(entry => ({
          id: entry.projectId, title: before.get(entry.projectId)?.title ?? decision.projects.find(p => p.projectId === entry.projectId)?.title ?? String(entry.projectId),
        })) });
      }
      const activatingProjects = db.select().from(schema.workItems).all()
        .filter(row => row.role === "story" && row.status === "active" &&
          (before.get(row.id)?.role !== "story" || before.get(row.id)?.status !== "active"))
        .map(row => ({ id: row.id, title: row.title }));
      const after = Graph.load(db, undefined, viewerMemberId);
      for (const project of activatingProjects) {
        if (before.has(project.id)) authorize(project.id);
        if (!after.projectsById.has(project.id)) throw AppError.notFound("project_not_found", "Project not found");
      }
      throw new PreviewRollback({ decision: null, activatingProjects });
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
  throw new Error("Activation preview must roll back");
}

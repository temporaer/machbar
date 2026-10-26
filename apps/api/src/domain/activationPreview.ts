import type { ActivationPreview, ProjectActivationDecisionSnapshot } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";

class PreviewRollback {
  constructor(readonly result: ActivationPreview) {}
}

/** Reuse the canonical mutation, including its proposed graph, in a rollback-only
 * transaction. No preview writes, activity, points or generated IDs survive. */
export function previewActivation(db: Db, mutate: () => unknown): ActivationPreview {
  try {
    db.transaction(() => {
      const before = new Map(db.select().from(schema.workItems).all().map(row => [row.id, row]));
      try {
        mutate();
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "project_commitment_resolution_required") throw error;
        const decision = error.details as unknown as ProjectActivationDecisionSnapshot;
        throw new PreviewRollback({ decision, activatingProjects: decision.expectedProjects.map(entry => ({
          id: entry.projectId, title: before.get(entry.projectId)?.title ?? decision.projects.find(p => p.projectId === entry.projectId)?.title ?? String(entry.projectId),
        })) });
      }
      const activatingProjects = db.select().from(schema.workItems).all()
        .filter(row => row.role === "story" && row.status === "active" &&
          (before.get(row.id)?.role !== "story" || before.get(row.id)?.status !== "active"))
        .map(row => ({ id: row.id, title: row.title }));
      throw new PreviewRollback({ decision: null, activatingProjects });
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
  throw new Error("Activation preview must roll back");
}

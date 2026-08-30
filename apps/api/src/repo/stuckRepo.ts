import type { StuckReason } from "@machbar/shared";
import type { Db } from "../db/client.js";
import { Graph } from "../domain/graph.js";

/**
 * Compatibility repository entry point for callers that need only project
 * stuck reasons. The actual decision model is owned by Graph's canonical
 * blocker analysis rather than duplicated in a second recursive SQL query.
 */
export function getStuckReasonsByProject(
  db: Db,
  today = new Date().toISOString().slice(0, 10),
): Map<number, StuckReason> {
  const graph = Graph.load(db, today);
  return new Map(
    graph
      .listStuckProjects()
      .map((project) => [project.id, project.stuckReason]),
  );
}

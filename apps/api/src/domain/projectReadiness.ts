import type { ProjectActivationReadiness } from "@machbar/shared";
import type { Db } from "../db/client.js";
import { getNextActionTaskIdsByProject } from "../repo/nextActionRepo.js";
import { type TaskBlockerAnalysis } from "./blockers.js";
import { Graph } from "./graph.js";

export function evaluateProjectActivationReadiness(input: {
  ownerMemberId: number | null;
  candidateTaskIds: readonly number[];
  projectTaskIds: readonly number[];
  blockerAnalysisByTask: ReadonlyMap<number, TaskBlockerAnalysis>;
  today: string;
}): ProjectActivationReadiness {
  const hasDriver = input.ownerMemberId !== null;
  const hasViableProgressPath = input.candidateTaskIds.length > 0;
  const hasHealthyFutureWaiting = input.projectTaskIds.some((taskId) => {
    const analysis = input.blockerAnalysisByTask.get(taskId);
    return (
      analysis?.blocked === true &&
      analysis.healthyProgressPath &&
      analysis.nextBlockerAttentionDate !== null &&
      analysis.nextBlockerAttentionDate > input.today
    );
  });
  return {
    ready:
      hasDriver && (hasViableProgressPath || hasHealthyFutureWaiting),
    hasDriver,
    hasViableProgressPath,
    hasHealthyFutureWaiting,
  };
}

export function getProjectActivationReadiness(
  db: Db,
  projectId: number,
  ownerMemberId: number | null,
  today = new Date().toISOString().slice(0, 10),
): ProjectActivationReadiness {
  const graph = Graph.load(db, today);
  const readiness = graph.projectWithComputed(projectId)?.activationReadiness;
  if (!readiness) {
    return evaluateProjectActivationReadiness({
      ownerMemberId,
      candidateTaskIds: getNextActionTaskIdsByProject(db).get(projectId) ?? [],
      projectTaskIds: [],
      blockerAnalysisByTask: new Map(),
      today,
    });
  }
  const hasDriver = ownerMemberId !== null;
  return {
    ...readiness,
    hasDriver,
    ready:
      hasDriver &&
      (readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting),
  };
}

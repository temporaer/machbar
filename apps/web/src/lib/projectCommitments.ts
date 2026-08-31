import type { ProjectWithActions } from "./api";

export function hasProjectProgressPath(project: ProjectWithActions): boolean {
  return (
    project.activationReadiness.hasViableProgressPath ||
    project.activationReadiness.hasHealthyFutureWaiting
  );
}

export function isProjectReadyToStart(project: ProjectWithActions): boolean {
  return project.activationReadiness.ready;
}

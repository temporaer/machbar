import type { ProjectActivationResolution } from "@machbar/shared";
import { api, type ProjectWithActions } from "./api";

export interface ProjectActivationRequirement {
  projectId: number;
  title: string;
  revision: number;
  ownerMemberId: number | null;
  required: Array<"driver" | "progressPath">;
}

export interface ProjectActivationPrompt {
  projects: ProjectActivationRequirement[];
  expectedProjects: Array<{ projectId: number; revision: number }>;
  targetRevision?: number;
  selectedDrivers: Record<number, number>;
  nextActionTitle: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredApiError(
  error: unknown,
): error is Error & { code: string; details?: Record<string, unknown> } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string";
}

export function projectActivationPromptFromError(
  error: unknown,
  previous?: ProjectActivationPrompt | null,
): ProjectActivationPrompt | null {
  if (!isStructuredApiError(error) || error.code !== "project_commitment_resolution_required") return null;
  const projects = error.details?.projects;
  const expectedProjects = error.details?.expectedProjects;
  if (!Array.isArray(projects) || !Array.isArray(expectedProjects)) return null;
  const parsedProjects: ProjectActivationRequirement[] = [];
  for (const value of projects) {
    if (!isRecord(value) || typeof value.projectId !== "number" || typeof value.title !== "string" ||
      typeof value.revision !== "number" || !(typeof value.ownerMemberId === "number" || value.ownerMemberId === null) ||
      !Array.isArray(value.required)) return null;
    const required = value.required.filter((entry): entry is "driver" | "progressPath" =>
      entry === "driver" || entry === "progressPath");
    parsedProjects.push({
      projectId: value.projectId,
      title: value.title,
      revision: value.revision,
      ownerMemberId: value.ownerMemberId,
      required,
    });
  }
  const parsedExpected: ProjectActivationPrompt["expectedProjects"] = [];
  for (const value of expectedProjects) {
    if (!isRecord(value) || typeof value.projectId !== "number" || typeof value.revision !== "number") return null;
    parsedExpected.push({ projectId: value.projectId, revision: value.revision });
  }
  const requiredDriverIds = new Set(
    parsedProjects.filter((project) => project.required.includes("driver")).map((project) => project.projectId),
  );
  const selectedDrivers = Object.fromEntries(
    Object.entries(previous?.selectedDrivers ?? {}).filter(([id]) => requiredDriverIds.has(Number(id))),
  );
  const targetRevision = typeof error.details?.targetRevision === "number"
    ? error.details.targetRevision
    : parsedExpected.find((entry) => parsedProjects.some((project) => project.projectId === entry.projectId))?.revision;
  return {
    projects: parsedProjects,
    expectedProjects: parsedExpected,
    ...(targetRevision !== undefined ? { targetRevision } : {}),
    selectedDrivers,
    nextActionTitle: previous?.nextActionTitle ?? "",
  };
}

/** Reload the current ancestor chain after a stale write, keeping only
 * decisions that still apply to the current requirements. */
export async function refreshProjectActivationPrompt(
  error: unknown,
  targetProjectId: number,
  previous?: ProjectActivationPrompt | null,
): Promise<ProjectActivationPrompt | null> {
  const fromError = projectActivationPromptFromError(error, previous);
  if (fromError) return fromError;
  if (!isStructuredApiError(error) || error.code !== "stale_write_conflict") return null;

  let projects: ProjectWithActions[];
  try {
    projects = await api.getProjects();
  } catch {
    return previous ?? null;
  }
  const byId = new Map(projects.map((project) => [project.id, project]));
  const chain: ProjectWithActions[] = [];
  const visited = new Set<number>();
  let current: ProjectWithActions | undefined = byId.get(targetProjectId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  const target = chain[0];
  if (!target || visited.has(current?.id ?? -1)) return null;

  const backlog = chain.filter((project) => project.status === "backlog");
  const required = backlog.flatMap((project) => {
    const readiness = project.activationReadiness;
    const decisions = readiness.requiredDecisions ?? [
      ...(!readiness.hasDriver ? ["driver" as const] : []),
      ...(!(readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting || readiness.hasHealthyFutureRevisit)
        ? ["progressPath" as const]
        : []),
    ];
    return decisions.length ? [{
      projectId: project.id,
      title: project.title,
      revision: project.revision,
      ownerMemberId: project.ownerMemberId,
      required: decisions,
    }] : [];
  });
  const requiredDriverIds = new Set(
    required.filter((project) => project.required.includes("driver")).map((project) => project.projectId),
  );
  return {
    projects: required,
    expectedProjects: backlog.map(({ id, revision }) => ({ projectId: id, revision })),
    targetRevision: target.revision,
    selectedDrivers: Object.fromEntries(
      Object.entries(previous?.selectedDrivers ?? {}).filter(([id]) => requiredDriverIds.has(Number(id))),
    ),
    nextActionTitle: previous?.nextActionTitle ?? "",
  };
}

export function projectActivationResolutionFromPrompt(
  prompt: ProjectActivationPrompt,
): ProjectActivationResolution | null {
  const requiresPath = prompt.projects.some((project) => project.required.includes("progressPath"));
  if (requiresPath && prompt.nextActionTitle.trim() === "") return null;
  const drivers = prompt.projects
    .filter((project) => project.required.includes("driver"))
    .flatMap((project) => {
      const ownerMemberId = prompt.selectedDrivers[project.projectId];
      return Number.isInteger(ownerMemberId) && ownerMemberId! > 0
        ? [{ projectId: project.projectId, ownerMemberId: ownerMemberId! }]
        : [];
    });
  if (drivers.length !== prompt.projects.filter((project) => project.required.includes("driver")).length) return null;
  return {
    expectedProjects: prompt.expectedProjects,
    drivers,
    ...(requiresPath ? { nextActionTitle: prompt.nextActionTitle.trim() } : {}),
  };
}

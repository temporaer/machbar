import type {
  ProjectActivationDecisionSnapshot,
  ProjectActivationRequirement,
  ProjectActivationResolution,
} from "@machbar/shared";
import { api } from "./api";

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

/** Reload current server requirements after a stale write, keeping only
 * decisions that still apply to the current transition. */
export async function refreshProjectActivationPrompt(
  error: unknown,
  targetProjectId: number,
  previous?: ProjectActivationPrompt | null,
  intent: "commitment" | "explicit_activation" = "commitment",
): Promise<ProjectActivationPrompt | null> {
  const fromError = projectActivationPromptFromError(error, previous);
  if (fromError) return fromError;
  if (!isStructuredApiError(error) || error.code !== "stale_write_conflict") return null;

  let snapshot: ProjectActivationDecisionSnapshot | undefined;
  try {
    const project = await api.getProject(targetProjectId);
    snapshot = intent === "explicit_activation"
      ? project.directActivationDecisionSnapshot
      : project.activationDecisionSnapshot;
  } catch {
    return previous ?? null;
  }
  if (!snapshot) return previous ?? null;
  const requiredDriverIds = new Set(
    snapshot.projects.filter((project) => project.required.includes("driver")).map((project) => project.projectId),
  );
  return {
    projects: snapshot.projects,
    expectedProjects: snapshot.expectedProjects,
    targetRevision: snapshot.targetRevision,
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

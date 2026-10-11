import type { ProjectActivationResolution } from "@machbar/shared";
import { ApiError } from "./api";

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
  selectedDrivers: Record<number, number>;
  nextActionTitle: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectActivationPromptFromError(error: unknown): ProjectActivationPrompt | null {
  if (!(error instanceof ApiError) || error.code !== "project_commitment_resolution_required") return null;
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
  return { projects: parsedProjects, expectedProjects: parsedExpected, selectedDrivers: {}, nextActionTitle: "" };
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProject } = vi.hoisted(() => ({ getProject: vi.fn() }));
vi.mock("./api", () => ({ api: { getProject } }));

import {
  projectActivationPromptFromError,
  refreshProjectActivationPrompt,
} from "./projectActivationResolution";

describe("project activation decisions from the server", () => {
  beforeEach(() => getProject.mockReset());

  it("does not reconstruct the chain or requirements from local project state", async () => {
    const error = Object.assign(new Error("stale"), { code: "stale_write_conflict" });
    const serverSnapshot = {
      targetRevision: 12,
      expectedProjects: [{ projectId: 7, revision: 12 }, { projectId: 3, revision: 4 }],
      projects: [{
        projectId: 3,
        title: "Oberprojekt",
        revision: 4,
        ownerMemberId: null,
        required: ["driver", "progressPath"],
      }],
    };
    getProject.mockResolvedValue({ directActivationDecisionSnapshot: serverSnapshot });

    await expect(refreshProjectActivationPrompt(error, 7, {
      projects: [],
      expectedProjects: [],
      selectedDrivers: { 3: 9, 8: 2 },
      nextActionTitle: "Erste Aktion",
    }, "explicit_activation")).resolves.toEqual({
      ...serverSnapshot,
      selectedDrivers: { 3: 9 },
      nextActionTitle: "Erste Aktion",
    });
    expect(getProject).toHaveBeenCalledWith(7);
  });

  it("uses current requirements returned with a missing-decision conflict", () => {
    const error = Object.assign(new Error("decisions required"), {
      code: "project_commitment_resolution_required",
      details: {
        projects: [{
          projectId: 5,
          title: "Projekt",
          revision: 8,
          ownerMemberId: null,
          required: ["driver", "progressPath"],
        }],
        expectedProjects: [{ projectId: 5, revision: 8 }],
        targetRevision: 8,
      },
    });
    expect(projectActivationPromptFromError(error, {
      projects: [],
      expectedProjects: [],
      selectedDrivers: { 5: 4 },
      nextActionTitle: "Schritt",
    })).toMatchObject({
      projects: [{ projectId: 5, required: ["driver", "progressPath"] }],
      selectedDrivers: { 5: 4 },
      nextActionTitle: "Schritt",
    });
  });
});

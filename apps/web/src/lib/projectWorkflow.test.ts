import { describe, expect, it } from "vitest";
import { makeCriterion, makeProject } from "../test/fixtures";
import { lifecyclePrerequisite } from "./projectWorkflow";

describe("lifecyclePrerequisite — story.complete", () => {
  it("completes immediately when a project has no acceptance criteria", () => {
    const story = makeProject({ status: "active", ownerMemberId: 1, acceptanceCriteria: [] });
    expect(lifecyclePrerequisite(story, "complete")).toBeNull();
  });

  it("completes immediately when every acceptance criterion is checked", () => {
    const story = makeProject({
      status: "active",
      ownerMemberId: 1,
      acceptanceCriteria: [
        makeCriterion({ checked: true }),
        makeCriterion({ checked: true }),
      ],
    });
    expect(lifecyclePrerequisite(story, "complete")).toBeNull();
  });

  it("requires the focused completion checklist when a criterion is unchecked", () => {
    const story = makeProject({
      status: "active",
      ownerMemberId: 1,
      acceptanceCriteria: [
        makeCriterion({ checked: true }),
        makeCriterion({ checked: false }),
      ],
    });
    expect(lifecyclePrerequisite(story, "complete")).toBe("openCriteria");
  });
});

describe("lifecyclePrerequisite — server activation requirements", () => {
  it("activates directly when a driver and healthy future revisit satisfy server readiness", () => {
    const story = makeProject({
      status: "backlog",
      ownerMemberId: 1,
      activationReadiness: {
        ready: true,
        hasDriver: true,
        hasViableProgressPath: false,
        hasHealthyFutureWaiting: false,
        hasHealthyFutureRevisit: true,
        requiredDecisions: [],
      },
    });
    expect(lifecyclePrerequisite(story, "activate")).toBeNull();
    expect(lifecyclePrerequisite(story, "reopen")).toBeNull();
  });

  it("opens the shared decision workflow from the server's missing driver and path requirements", () => {
    const story = makeProject({
      status: "backlog",
      ownerMemberId: null,
      activationReadiness: {
        ready: false,
        hasDriver: false,
        hasViableProgressPath: false,
        hasHealthyFutureWaiting: false,
        requiredDecisions: ["driver", "progressPath"],
      },
    });
    expect(lifecyclePrerequisite(story, "activate")).toBe("driver");
    expect(lifecyclePrerequisite(story, "activate", 7)).toBe("progressPath");
  });
});

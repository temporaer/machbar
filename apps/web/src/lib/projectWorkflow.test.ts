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

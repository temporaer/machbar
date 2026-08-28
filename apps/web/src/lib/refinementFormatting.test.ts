import type { RefinementIssue } from "@machbar/shared";
import { describe, expect, it } from "vitest";
import { formatRefinementIssue } from "./refinementFormatting";

describe("formatRefinementIssue", () => {
  it("turns structured refinement codes into English copy", () => {
    const issue: RefinementIssue = {
      code: "missing_driver",
      severity: "warning",
      suggestedAction: { code: "assign_driver" },
      entityType: "project",
      entityId: 4,
      entityTitle: "Kitchen",
      projectId: 4,
      projectTitle: "Kitchen",
    };

    expect(formatRefinementIssue(issue, "en")).toEqual({
      label: "Project lead missing",
      explanation: "The project needs someone to keep track of it.",
      actionLabel: "Assign project lead",
    });
  });

  it("uses dependency metadata instead of server-provided prose", () => {
    const issue: RefinementIssue = {
      code: "blocked_without_clear_path",
      severity: "warning",
      suggestedAction: { code: "clarify_task", targetTaskId: 2 },
      entityType: "task",
      entityId: 1,
      entityTitle: "Install shelf",
      projectId: 4,
      projectTitle: "Kitchen",
      blockingReason: "captured",
      dependencyPath: [
        { taskId: 1, title: "Install shelf" },
        { taskId: 2, title: "Buy anchors" },
      ],
    };

    expect(formatRefinementIssue(issue, "en")).toEqual({
      label: "Blocking task is not clarified",
      explanation:
        "“Install shelf” is waiting for “Buy anchors”. This task has only been captured and is not ready yet.",
      actionLabel: "Clarify Buy anchors",
    });
  });
});

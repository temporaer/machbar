import type { ProjectDetail } from "./api";
import type { Task } from "@machbar/shared";
import { describe, expect, it } from "vitest";
import { serializeProjectForShare, serializeTaskForShare } from "./shareText";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: null,
    parentTaskId: null,
    title: "Angebot einholen",
    notes: "",
    status: "actionable",
    needsClarification: false,
    ownerMemberId: null,
    ownerInheritanceMode: "inherit",
    createdByMemberId: null,
    dueDate: null,
    scheduledDate: null,
    priority: null,
    size: null,
    position: 0,
    completedAt: null,
    cancelledAt: null,
    repeatAfterDays: null,
    allowedDeviationDays: null,
    reminderAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    effectiveTags: [],
    effectiveAreaTags: [],
    effectiveActorTags: [],
    effectiveContextTags: [],
    explicitTags: [],
    excludedTagIds: [],
    blocked: false,
    executable: true,
    externalWait: null,
    nextBlockerAttentionDate: null,
    blockers: [],
    dependencies: [],
    children: [],
    ...overrides,
    revision: overrides.revision ?? 1,
  };
}

function makeProject(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 3,
    title: "Umzug organisieren",
    notes: "",
    status: "active",
    ownerMemberId: null,
    dueDate: null,
    scheduledDate: null,
    position: 0,
    tags: [],
    effectiveTags: [],
    effectiveAreaTags: [],
    primaryAreaTag: null,
    acceptanceCriteria: [],
    availableActions: [],
    tasks: [],
    ...overrides,
    revision: overrides.revision ?? 1,
  };
}

describe("share text serializers", () => {
  it("serializes a standalone task title, due date, and notes", () => {
    expect(
      serializeTaskForShare(
        makeTask({ dueDate: "2026-09-01", notes: "Beim Anbieter nachfragen." }),
      ),
    ).toBe("Angebot einholen\n\nFällig: 01.09.2026\n\nBeim Anbieter nachfragen.");
  });

  it("serializes project metadata and recursively indented task statuses", () => {
    const child = makeTask({ id: 2, title: "Preise vergleichen", status: "done" });
    const parent = makeTask({ id: 1, title: "Angebote einholen", children: [child] });
    expect(
      serializeProjectForShare(
        makeProject({
          dueDate: "2026-09-15",
          notes: "Bis zum Monatsende abschließen.",
          tasks: [parent],
        }),
      ),
    ).toBe(
      "Umzug organisieren\n\n☐ Angebote einholen\n  ✓ Preise vergleichen\n\nFällig: 15.09.2026\n\nBis zum Monatsende abschließen.",
    );
  });

  it("serializes labels and dates in English", () => {
    expect(
      serializeTaskForShare(
        makeTask({ dueDate: "2026-09-01", notes: "Call the supplier." }),
        "en",
      ),
    ).toBe(
      "Angebot einholen\n\nDue: 09/01/2026\n\nCall the supplier.",
    );
  });
});

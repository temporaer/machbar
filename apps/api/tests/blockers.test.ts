import { describe, expect, it } from "vitest";
import type { ProjectStatus, TaskStatus } from "@machbar/shared";
import {
  analyzeTaskBlockers,
  type BlockerTaskInput,
} from "../src/domain/blockers.js";

const today = "2026-08-30";

function task(
  id: number,
  overrides: Partial<BlockerTaskInput> = {},
): BlockerTaskInput {
  return {
    id,
    title: `Task ${id}`,
    status: "actionable" as TaskStatus,
    projectId: null,
    scheduledDate: null,
    externalWait: null,
    dependencies: [],
    ...overrides,
  };
}

function analyze(
  values: BlockerTaskInput[],
  projects: Array<[number, ProjectStatus]> = [],
) {
  return analyzeTaskBlockers(
    new Map(values.map((value) => [value.id, value])),
    new Map(projects),
    today,
  );
}

describe("canonical blocker analysis", () => {
  it("separates lifecycle status from blocked and executable state", () => {
    const result = analyze([
      task(1),
      task(2, { status: "captured" }),
      task(3, { status: "someday" }),
      task(4, { status: "done" }),
      task(5, { status: "cancelled" }),
    ]);

    expect(result.get(1)).toMatchObject({ blocked: false, executable: true });
    for (const id of [2, 3, 4, 5]) {
      expect(result.get(id)).toMatchObject({
        blocked: false,
        executable: false,
      });
    }
  });

  it("combines dependency and external blockers and requires both to clear", () => {
    const result = analyze([
      task(1, {
        externalWait: { waitingFor: "IKEA" },
        scheduledDate: "2026-09-01",
        dependencies: [{ dependsOnTaskId: 2, resolved: false }],
      }),
      task(2),
    ]);

    expect(result.get(1)).toMatchObject({
      blocked: true,
      executable: false,
      healthyProgressPath: true,
      nextBlockerAttentionDate: "2026-09-01",
    });
  });

  it("derives the earliest transitive attention date without mutating schedules", () => {
    const a = task(1, {
      dependencies: [
        { dependsOnTaskId: 2, resolved: false },
        { dependsOnTaskId: 4, resolved: false },
      ],
    });
    const b = task(2, {
      dependencies: [{ dependsOnTaskId: 3, resolved: false }],
    });
    const c = task(3, {
      externalWait: { waitingFor: "External event" },
      scheduledDate: "2026-09-02",
    });
    const saturday = task(4, { scheduledDate: "2026-09-05" });
    const result = analyze([a, b, c, saturday]);

    expect(result.get(1)?.nextBlockerAttentionDate).toBe("2026-09-02");
    expect(result.get(2)?.nextBlockerAttentionDate).toBe("2026-09-02");
    expect(a.scheduledDate).toBeNull();
    expect(b.scheduledDate).toBeNull();
  });

  it("diagnoses missing and reached external follow-ups precisely", () => {
    const result = analyze([
      task(1, { externalWait: { waitingFor: "External event" } }),
      task(2, {
        externalWait: { waitingFor: "Reply" },
        scheduledDate: today,
      }),
    ]);

    expect(result.get(1)?.diagnoses).toEqual([
      expect.objectContaining({
        reason: "waiting_without_followup",
        targetTaskId: 1,
      }),
    ]);
    expect(result.get(2)?.diagnoses).toEqual([
      expect.objectContaining({ reason: "followup_due", targetTaskId: 2 }),
    ]);
  });

  it("targets captured, someday, backlog, and terminal prerequisites", () => {
    const root = task(1, {
      dependencies: [
        { dependsOnTaskId: 2, resolved: false },
        { dependsOnTaskId: 3, resolved: false },
        { dependsOnTaskId: 4, resolved: false },
        { dependsOnTaskId: 5, resolved: false },
      ],
    });
    const result = analyze(
      [
        root,
        task(2, { status: "captured" }),
        task(3, { status: "someday" }),
        task(4, { projectId: 40 }),
        task(5, { projectId: 50 }),
      ],
      [
        [40, "backlog"],
        [50, "completed"],
      ],
    );

    expect(result.get(1)?.diagnoses.map((entry) => entry.reason)).toEqual([
      "captured",
      "someday",
      "backlog_project",
      "terminal_project",
    ]);
    expect(result.get(1)?.healthyProgressPath).toBe(false);
  });

  it("fails safely when corrupt dependency data contains a cycle", () => {
    const result = analyze([
      task(1, {
        dependencies: [{ dependsOnTaskId: 2, resolved: false }],
      }),
      task(2, {
        dependencies: [{ dependsOnTaskId: 1, resolved: false }],
      }),
    ]);

    expect(result.get(1)?.diagnoses).toEqual([
      expect.objectContaining({ reason: "cycle", targetTaskId: 1 }),
    ]);
    expect(result.get(1)?.healthyProgressPath).toBe(false);
  });
});

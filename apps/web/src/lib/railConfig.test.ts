import { beforeEach, describe, expect, it } from "vitest";
import {
  overflowRailCommands,
  projectRailCommands,
  readRailFavorites,
  taskRailCommands,
  writeRailFavorites,
} from "./railConfig";
import type { TaskRailCommand } from "./commands";

describe("rail configuration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses the requested three-slot task defaults", () => {
    expect(readRailFavorites("task")).toEqual([
      "task.plan",
      "task.waitingLifecycle",
      "task.split",
    ]);
  });

  it("keeps task and project favorites independent", () => {
    writeRailFavorites("task", [
      "task.tags",
      "task.contexts",
      "task.priority",
    ]);
    writeRailFavorites("project", [
      "story.tags",
      "story.contexts",
      "story.lifecycle",
    ]);

    expect(readRailFavorites("task")).toEqual([
      "task.tags",
      "task.contexts",
      "task.priority",
    ]);
    expect(readRailFavorites("project")).toEqual([
      "story.tags",
      "story.contexts",
      "story.lifecycle",
    ]);
  });

  it("derives overflow without pinned commands", () => {
    const favorites: readonly TaskRailCommand[] = [
      "task.plan",
      "task.priority",
      "task.tags",
    ];
    const overflow = overflowRailCommands("task", favorites);
    expect(overflow).not.toContain("task.plan");
    expect(overflow).not.toContain("task.priority");
    expect(overflow).not.toContain("task.tags");
    expect(overflow).toEqual(
      taskRailCommands.filter((command) => !favorites.includes(command)),
    );
  });

  it("falls back when persisted values are invalid or not exactly three unique commands", () => {
    window.localStorage.setItem(
      "machbar:rail-favorites",
      JSON.stringify({
        task: ["task.plan", "task.plan", "not-a-command"],
        project: ["story.defer", "story.assignDriver"],
      }),
    );

    expect(readRailFavorites("task")).toEqual([
      "task.plan",
      "task.waitingLifecycle",
      "task.split",
    ]);
    expect(readRailFavorites("project")).toEqual([
      "story.defer",
      "story.assignDriver",
      "story.planWork",
    ]);
  });

  it("falls back to defaults when an old stored favorite is task.discard", () => {
    window.localStorage.setItem(
      "machbar:rail-favorites:1",
      JSON.stringify({
        task: ["task.plan", "task.waitingLifecycle", "task.discard"],
      }),
    );

    expect(readRailFavorites("task", 1)).toEqual([
      "task.plan",
      "task.waitingLifecycle",
      "task.split",
    ]);
  });

  it("rejects cross-kind commands even when three values are stored", () => {
    window.localStorage.setItem(
      "machbar:rail-favorites",
      JSON.stringify({
        task: ["story.defer", "story.tags", "story.lifecycle"],
        project: ["task.plan", "task.tags", "task.lifecycle"],
      }),
    );

    expect(readRailFavorites("task")).toEqual([
      "task.plan",
      "task.waitingLifecycle",
      "task.split",
    ]);
    expect(readRailFavorites("project")).toEqual([
      "story.defer",
      "story.assignDriver",
      "story.planWork",
    ]);
    expect(projectRailCommands).toContain("story.defer");
  });

  it("namespaces favorites per member so two members stay independent", () => {
    writeRailFavorites("task", ["task.tags", "task.contexts", "task.priority"], 1);
    writeRailFavorites("task", ["task.plan", "task.split", "task.assignOwner"], 2);

    expect(readRailFavorites("task", 1)).toEqual([
      "task.tags",
      "task.contexts",
      "task.priority",
    ]);
    expect(readRailFavorites("task", 2)).toEqual([
      "task.plan",
      "task.split",
      "task.assignOwner",
    ]);
    // No member (unauthenticated/local) falls back to defaults, not either member's data.
    expect(readRailFavorites("task", null)).toEqual([
      "task.plan",
      "task.waitingLifecycle",
      "task.split",
    ]);
  });
});

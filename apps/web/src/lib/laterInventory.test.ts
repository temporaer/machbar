import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { selectLaterInventoryRoots } from "./laterInventory";

describe("selectLaterInventoryRoots", () => {
  it("keeps active standalone tasks out and groups deferred roots without duplicating descendants", () => {
    const project = makeProject({
      id: 1,
      title: "Backlog project",
      status: "backlog",
    });
    const deferredChildProject = makeProject({
      id: 2,
      title: "Deferred child project",
      status: "active",
      parentId: project.id,
      effectivelyDeferred: true,
    });
    const deferredProjectTask = makeTask({
      id: 3,
      title: "Deferred project task",
      projectId: deferredChildProject.id,
      status: "someday",
      effectivelyDeferred: true,
    });
    const activeTask = makeTask({
      id: 4,
      title: "Available standalone task",
      status: "actionable",
      effectivelyDeferred: false,
    });
    const deferredTask = makeTask({
      id: 5,
      title: "Deferred standalone task",
      status: "someday",
      effectivelyDeferred: true,
    });

    const inventory = selectLaterInventoryRoots(
      [project, deferredChildProject],
      [deferredProjectTask, activeTask, deferredTask],
      { query: "", scope: "all", currentMemberId: null },
    );

    expect(inventory.projects.map((item) => item.id)).toEqual([project.id]);
    expect(inventory.tasks.map((item) => item.id)).toEqual([deferredTask.id]);
  });

  it("promotes a deferred child when its parent is hidden by search and leaves unknown deferral unconfirmed", () => {
    const parent = makeProject({
      id: 10,
      title: "Unmatched parent",
      status: "backlog",
    });
    const child = makeProject({
      id: 11,
      title: "Matching child",
      status: "active",
      parentId: parent.id,
      effectivelyDeferred: true,
    });
    const unknownTask = makeTask({
      id: 12,
      title: "Unknown ancestor state",
      status: "actionable",
      effectivelyDeferred: null,
    });

    const inventory = selectLaterInventoryRoots(
      [parent, child],
      [unknownTask],
      { query: "matching", scope: "all", currentMemberId: null },
    );

    expect(inventory.projects.map((item) => item.id)).toEqual([child.id]);
    expect(inventory.tasks).toEqual([]);
  });

  it("includes unassigned household tasks in mine scope but excludes other owners and private work", () => {
    const unassigned = makeTask({
      id: 20,
      title: "Unassigned household task",
      status: "someday",
      effectiveOwnerId: null,
    });
    const otherOwner = makeTask({
      id: 21,
      title: "Other owner task",
      status: "someday",
      effectiveOwnerId: 2,
    });
    const privateWork = makeTask({
      id: 22,
      title: "Private work task",
      status: "someday",
      scope: "work",
      effectiveOwnerId: 1,
    });

    const inventory = selectLaterInventoryRoots(
      [],
      [unassigned, otherOwner, privateWork],
      { query: "", scope: "mine", currentMemberId: 1 },
    );

    expect(inventory.tasks.map((item) => item.id)).toEqual([unassigned.id]);
  });
});

import { describe, expect, it } from "vitest";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import {
  sortDependencies,
  sortDependencyCandidates,
  sortInventoryTasks,
  sortMembersByName,
  sortProjectDestinations,
  sortProjectsByTitle,
} from "./sortOrder";

describe("presentation ordering", () => {
  it("sorts members and lookup projects by localized names with stable ids", () => {
    const members = [
      makeMember({ id: 3, name: "Zulu" }),
      makeMember({ id: 2, name: "Änne" }),
      makeMember({ id: 1, name: "Änne" }),
    ];
    const projects = [
      makeProject({ id: 2, title: "Zelt" }),
      makeProject({ id: 1, title: "Äpfel" }),
    ];

    expect(sortMembersByName(members, "de").map((member) => member.id)).toEqual([
      1, 2, 3,
    ]);
    expect(sortProjectsByTitle(projects, "de").map((project) => project.id)).toEqual([
      1, 2,
    ]);
  });

  it("orders project destinations by lifecycle before title", () => {
    const projects = [
      makeProject({ id: 1, title: "A", status: "archived" }),
      makeProject({ id: 2, title: "Z", status: "active" }),
      makeProject({ id: 3, title: "B", status: "backlog" }),
      makeProject({ id: 4, title: "A", status: "completed" }),
    ];

    expect(
      sortProjectDestinations(projects, "de").map((project) => project.id),
    ).toEqual([2, 3, 4, 1]);
  });

  it("sorts inventory tasks by match quality, lifecycle, and title", () => {
    const tasks = [
      makeTask({ id: 1, title: "Material", notes: "Farbe kaufen" }),
      makeTask({ id: 2, title: "Farbe bestellen", status: "done" }),
      makeTask({ id: 3, title: "Farbe", status: "actionable" }),
      makeTask({ id: 4, title: "Wandfarbe wählen", status: "actionable" }),
    ];

    expect(sortInventoryTasks(tasks, "Farbe", "de").map((task) => task.id)).toEqual([
      3, 2, 4, 1,
    ]);
    expect(sortInventoryTasks(tasks, "", "de").map((task) => task.id)).toEqual([
      3, 1, 4, 2,
    ]);
  });

  it("ranks dependency candidates by match, project, open state, and title", () => {
    const existing = makeTask({ id: 8, title: "Existing" });
    const current = makeTask({
      id: 10,
      projectId: 5,
      dependencies: [
        {
          id: 1,
          taskId: 10,
          dependsOnTaskId: existing.id,
          title: existing.title,
          resolved: false,
        },
      ],
    });
    const candidates = [
      current,
      existing,
      makeTask({ id: 1, title: "Freigabe", projectId: 9, status: "done" }),
      makeTask({ id: 2, title: "Freigabe", projectId: 5 }),
      makeTask({ id: 3, title: "Bau Freigabe", projectId: 5 }),
      makeTask({ id: 4, title: "Notiz", notes: "Freigabe", projectId: 5 }),
    ];

    expect(
      sortDependencyCandidates(candidates, current, "Freigabe", "de").map(
        (task) => task.id,
      ),
    ).toEqual([2, 1, 3, 4]);
  });

  it("lists unresolved dependencies first and then by localized title", () => {
    const current = makeTask({
      dependencies: [
        {
          id: 1,
          taskId: 10,
          dependsOnTaskId: 3,
          title: "Zulu",
          resolved: false,
        },
        {
          id: 2,
          taskId: 10,
          dependsOnTaskId: 2,
          title: "Änderung",
          resolved: true,
        },
        {
          id: 3,
          taskId: 10,
          dependsOnTaskId: 1,
          title: "Änderung",
          resolved: false,
        },
      ],
    });

    expect(
      sortDependencies(current.dependencies, "de").map(
        (dependency) => dependency.dependsOnTaskId,
      ),
    ).toEqual([1, 3, 2]);
  });
});

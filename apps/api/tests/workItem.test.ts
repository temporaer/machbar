import { describe, expect, it } from "vitest";
import { Graph } from "../src/domain/graph.js";
import {
  projectLifecycle,
  projectToWorkItem,
  taskLifecycle,
  taskToWorkItem,
  workItemLabel,
} from "../src/domain/workItem.js";
import {
  closeTestContext,
  createTestContext,
  insertTestProject,
  insertTestTask,
  type TestContext,
} from "./helpers.js";

describe("WorkItem projection (Phase 1)", () => {
  it("maps every task status to the shared lifecycle vocabulary and role-specific label", () => {
    expect(taskLifecycle("captured")).toBe("captured");
    expect(taskLifecycle("actionable")).toBe("active");
    expect(taskLifecycle("someday")).toBe("backlog");
    expect(taskLifecycle("done")).toBe("done");
    expect(taskLifecycle("cancelled")).toBe("cancelled");

    expect(workItemLabel("task", taskLifecycle("actionable"))).toBe("actionable");
    expect(workItemLabel("task", taskLifecycle("someday"))).toBe("someday");
    expect(workItemLabel("task", taskLifecycle("done"))).toBe("done");
  });

  it("maps every project status to the shared lifecycle vocabulary and role-specific label", () => {
    expect(projectLifecycle("backlog")).toBe("backlog");
    expect(projectLifecycle("active")).toBe("active");
    expect(projectLifecycle("completed")).toBe("done");
    expect(projectLifecycle("archived")).toBe("backlog");

    expect(workItemLabel("story", projectLifecycle("backlog"))).toBe("backlog");
    expect(workItemLabel("story", projectLifecycle("active"))).toBe("active");
    expect(workItemLabel("story", projectLifecycle("completed"))).toBe("completed");
    expect(
      workItemLabel("story", projectLifecycle("archived"), { archived: true }),
    ).toBe("archived");
  });

  it("projects a task tree (with nested subtasks) into a WorkItem tree, preserving id/revision/hierarchy", async () => {
    let ctx: TestContext = createTestContext();
    try {
      const parent = insertTestTask(ctx.handle.db, { title: "Parent task", status: "captured" });
      const child = insertTestTask(ctx.handle.db, {
          title: "Child task",
          status: "actionable",
          parentTaskId: parent.id,
        });

      const graph = Graph.load(ctx.handle.db, "2026-01-01");
      const parentRecord = graph.allTasks().find((t) => t.id === parent.id)!;
      const item = taskToWorkItem(parentRecord);

      expect(item.id).toBe(parent.id);
      expect(item.revision).toBe(parent.revision);
      expect(item.role).toBe("task");
      expect(item.lifecycle).toBe("captured");
      expect(item.label).toBe("captured");
      expect(item.children).toHaveLength(1);
      expect(item.children[0]!.id).toBe(child.id);
      expect(item.children[0]!.label).toBe("actionable");
    } finally {
      await closeTestContext(ctx);
    }
  });

  it("projects a project and its root-level tasks into a story WorkItem, excluding non-root tasks from the direct children", async () => {
    let ctx: TestContext = createTestContext();
    try {
      const project = insertTestProject(ctx.handle.db, { title: "Renovate", status: "active" });
      const root = insertTestTask(ctx.handle.db, { title: "Measure walls", status: "actionable", projectId: project.id });
      insertTestTask(ctx.handle.db, {
          title: "Buy paint",
          status: "captured",
          projectId: project.id,
          parentTaskId: root.id,
        });

      const graph = Graph.load(ctx.handle.db, "2026-01-01");
      const projectRecord = graph.projectWithComputed(project.id)!;
      const rootTasks = graph
        .tasksForProject(project.id)
        .filter((t) => t.parentTaskId === null);
      const item = projectToWorkItem(projectRecord, rootTasks);

      expect(item.id).toBe(project.id);
      expect(item.role).toBe("story");
      expect(item.lifecycle).toBe("active");
      expect(item.label).toBe("active");
      // Only the root task is a direct child; its subtask is nested one
      // level deeper (mirroring the existing task hierarchy).
      expect(item.children).toHaveLength(1);
      expect(item.children[0]!.id).toBe(root.id);
      expect(item.children[0]!.children).toHaveLength(1);
    } finally {
      await closeTestContext(ctx);
    }
  });
});

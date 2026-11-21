import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { archiveTerminalWorkBatch } from "../src/repo/operationalArchiveRepo.js";
import { reopenTask } from "../src/domain/taskWorkflow.js";
import { createTestDatabase, insertTestProject, insertTestTask } from "./database.js";

describe("incremental operational archive", () => {
  let handle: DbHandle;

  beforeEach(() => { handle = createTestDatabase(); });
  afterEach(() => { handle.close(); });

  it("archives terminal task trees bottom-up in bounded, idempotent batches", () => {
    const parent = insertTestTask(handle.db, { title: "Finished parent", status: "done" });
    const child = insertTestTask(handle.db, {
      title: "Finished child", status: "cancelled", parentTaskId: parent.id,
    });

    expect(archiveTerminalWorkBatch(handle.db, { now: "2026-11-21T12:00:00.000Z", limit: 1 })).toBe(1);
    expect(handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, child.id)).get()?.operationalArchivedAt).toBe("2026-11-21T12:00:00.000Z");
    expect(handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, parent.id)).get()?.operationalArchivedAt).toBeNull();
    expect(archiveTerminalWorkBatch(handle.db, { now: "2026-11-21T12:01:00.000Z", limit: 1 })).toBe(1);
    expect(archiveTerminalWorkBatch(handle.db, { limit: 1 })).toBe(0);

    expect(Graph.load(handle.db).tasksById.has(child.id)).toBe(true);
    expect(Graph.loadOperational(handle.db).tasksById.has(child.id)).toBe(false);
    expect(Graph.loadOperational(handle.db).tasksById.has(parent.id)).toBe(false);
  });

  it("does not archive terminal ancestors while any descendant remains operational", () => {
    const parent = insertTestTask(handle.db, { title: "Terminal parent", status: "done" });
    const child = insertTestTask(handle.db, { title: "Still open", parentTaskId: parent.id });
    expect(archiveTerminalWorkBatch(handle.db)).toBe(0);
    expect(Graph.loadOperational(handle.db).tasksById.has(parent.id)).toBe(true);
    expect(Graph.loadOperational(handle.db).tasksById.has(child.id)).toBe(true);
  });

  it("handles nested project and task boundaries from the leaves upward", () => {
    const root = insertTestProject(handle.db, { title: "Finished project", status: "completed" });
    const nested = insertTestProject(handle.db, { title: "Nested finished project", status: "completed", parentId: root.id });
    const task = insertTestTask(handle.db, { title: "Finished task", status: "done", projectId: nested.id });

    expect(archiveTerminalWorkBatch(handle.db, { limit: 10 })).toBe(1);
    expect(archiveTerminalWorkBatch(handle.db, { limit: 10 })).toBe(1);
    expect(archiveTerminalWorkBatch(handle.db, { limit: 10 })).toBe(1);
    expect(Graph.loadOperational(handle.db).tasksById.has(task.id)).toBe(false);
    expect(Graph.loadOperational(handle.db).projectsById.has(nested.id)).toBe(false);
    expect(Graph.loadOperational(handle.db).projectsById.has(root.id)).toBe(false);
    expect(Graph.load(handle.db).projectsById.has(root.id)).toBe(true);
  });

  it("retains terminal task facts inside an active project for completion summaries", () => {
    const project = insertTestProject(handle.db, { title: "Active project", status: "active" });
    const task = insertTestTask(handle.db, { title: "Finished project task", status: "done", projectId: project.id });

    expect(archiveTerminalWorkBatch(handle.db)).toBe(0);
    const operational = Graph.loadOperational(handle.db);
    expect(operational.tasksById.has(task.id)).toBe(true);
    expect(operational.projectWithComputed(project.id)?.doneCount).toBe(1);
  });

  it("keeps recurring tasks and reference tasks out of archival candidates", () => {
    const recurring = insertTestTask(handle.db, { title: "Recurring", status: "done", repeatAfterDays: 7 });
    const reference = insertTestTask(handle.db, { title: "Reference", status: "done", taskKind: "reference" });
    expect(archiveTerminalWorkBatch(handle.db)).toBe(0);
    expect(Graph.loadOperational(handle.db).tasksById.has(recurring.id)).toBe(true);
    expect(Graph.loadOperational(handle.db).tasksById.has(reference.id)).toBe(true);
  });

  it("restores archived ancestors atomically when a terminal task is reopened", () => {
    const parent = insertTestTask(handle.db, { title: "Finished parent", status: "done" });
    const child = insertTestTask(handle.db, { title: "Finished child", status: "done", parentTaskId: parent.id });
    expect(archiveTerminalWorkBatch(handle.db, { limit: 10 })).toBe(1);
    expect(archiveTerminalWorkBatch(handle.db, { limit: 10 })).toBe(1);

    reopenTask(handle.db, child.id);

    expect(Graph.loadOperational(handle.db).tasksById.has(parent.id)).toBe(true);
    expect(Graph.loadOperational(handle.db).tasksById.get(child.id)?.status).toBe("actionable");
    expect(handle.db.select().from(schema.workItems).where(eq(schema.workItems.id, parent.id)).get()?.operationalArchivedAt).toBeNull();
  });

  it("retains the minimal visible fact for an archived completed prerequisite", () => {
    const prerequisite = insertTestTask(handle.db, { title: "Finished prerequisite", status: "done" });
    const dependent = insertTestTask(handle.db, { title: "Open dependent" });
    handle.db.insert(schema.taskDependencies).values({ taskId: dependent.id, dependsOnTaskId: prerequisite.id }).run();
    handle.db.update(schema.workItems).set({ operationalArchivedAt: "2026-11-21T12:00:00.000Z" })
      .where(eq(schema.workItems.id, prerequisite.id)).run();

    const graph = Graph.loadOperational(handle.db);
    expect(graph.tasksById.has(prerequisite.id)).toBe(false);
    expect(graph.tasksById.get(dependent.id)?.dependencies).toEqual([
      expect.objectContaining({ title: "Finished prerequisite", resolved: true }),
    ]);
  });

  it("does not reveal an archived private prerequisite to another viewer", () => {
    const owner = handle.db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = handle.db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const prerequisite = insertTestTask(handle.db, {
      title: "Private finished prerequisite", status: "done", scope: "work",
      ownerMemberId: owner.id, ownerInheritanceMode: "explicit",
    });
    const dependent = insertTestTask(handle.db, { title: "Household dependent" });
    handle.db.insert(schema.taskDependencies).values({ taskId: dependent.id, dependsOnTaskId: prerequisite.id }).run();
    handle.db.update(schema.workItems).set({ operationalArchivedAt: "2026-11-21T12:00:00.000Z" })
      .where(eq(schema.workItems.id, prerequisite.id)).run();

    const graph = Graph.loadOperational(handle.db, undefined, other.id);
    expect(graph.tasksById.get(dependent.id)?.dependencies).toEqual([]);
    expect(JSON.stringify(graph.tasksById.get(dependent.id))).not.toContain("Private finished prerequisite");
  });

  it("offers a history count on the operational parent while detail reads retain the full outline", () => {
    const parent = insertTestTask(handle.db, { title: "Ongoing parent" });
    const child = insertTestTask(handle.db, { title: "Finished child", status: "done", parentTaskId: parent.id });
    handle.db.update(schema.workItems).set({ operationalArchivedAt: "2026-11-21T12:00:00.000Z" })
      .where(eq(schema.workItems.id, child.id)).run();

    expect(Graph.loadOperational(handle.db).tasksById.get(parent.id)?.archivedTerminalChildrenCount).toBe(1);
    expect(Graph.load(handle.db).tasksById.get(parent.id)?.children.map((task) => task.id)).toContain(child.id);
  });

  it("does not expose archived private-child counts to an unauthorized viewer", () => {
    const owner = handle.db.insert(schema.members).values({ name: "Owner", color: "#123456" }).returning().get();
    const other = handle.db.insert(schema.members).values({ name: "Other", color: "#654321" }).returning().get();
    const parent = insertTestTask(handle.db, { title: "Household parent" });
    const child = insertTestTask(handle.db, {
      title: "Private archived child", status: "done", parentTaskId: parent.id,
      scope: "work", ownerMemberId: owner.id, ownerInheritanceMode: "explicit",
    });
    handle.db.update(schema.workItems).set({ operationalArchivedAt: "2026-11-21T12:00:00.000Z" })
      .where(eq(schema.workItems.id, child.id)).run();

    expect(Graph.loadOperational(handle.db, undefined, other.id).tasksById.get(parent.id)?.archivedTerminalChildrenCount).toBeUndefined();
    expect(Graph.loadOperational(handle.db, undefined, owner.id).tasksById.get(parent.id)?.archivedTerminalChildrenCount).toBe(1);
  });

  it("keeps the canonical task-only search projection independent from archive filtering", () => {
    insertTestProject(handle.db, { title: "Project shell", status: "active" });
    insertTestTask(handle.db, { title: "Visible task" });
    const completeGraphTasks = Graph.load(handle.db, undefined, undefined).allTasks();
    expect(Graph.loadSearchTasks(handle.db, undefined)).toEqual(completeGraphTasks);
  });
});

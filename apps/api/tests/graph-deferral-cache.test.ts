import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { createTestDatabase, insertTestProject, insertTestTask } from "./database.js";

describe("graph effective deferral", () => {
  let handle: DbHandle;
  beforeEach(() => { handle = createTestDatabase(); });
  afterEach(() => { handle.close(); });

  it("preserves true, false and unknown ancestry independently of the selected-project hypothetical", () => {
    const member = handle.db.insert(schema.members).values({ name: "Driver", color: "#111111" }).returning().get();
    const ancestor = insertTestProject(handle.db, { title: "Parked ancestor" });
    const project = insertTestProject(handle.db, { title: "Selected", parentId: ancestor.id, ownerMemberId: member.id });
    const action = insertTestTask(handle.db, { title: "Action", projectId: project.id });
    const parent = insertTestTask(handle.db, { title: "Parked parent", projectId: project.id, status: "someday" });
    const child = insertTestTask(handle.db, { title: "Nested action", parentTaskId: parent.id });
    const standalone = insertTestTask(handle.db, { title: "Independent" });
    const graph = Graph.load(handle.db);

    expect(graph.effectiveDeferralFor(action.id)).toBe(true);
    expect(graph.effectiveDeferralFor(child.id)).toBe(true);
    expect(graph.effectiveDeferralFor(standalone.id)).toBe(false);
    expect(graph.effectiveDeferralFor(-1)).toBe(false);
    expect(graph.projectsById.get(project.id)?.activationReadiness).toMatchObject({ hasViableProgressPath: true });

    const nestedOnly = insertTestProject(handle.db, { title: "Nested only", parentId: ancestor.id, ownerMemberId: member.id });
    const nestedParent = insertTestTask(handle.db, { title: "Parked nested parent", projectId: nestedOnly.id, status: "someday" });
    insertTestTask(handle.db, { title: "Nested only action", parentTaskId: nestedParent.id });
    expect(Graph.load(handle.db).projectsById.get(nestedOnly.id)?.activationReadiness).toMatchObject({ hasViableProgressPath: false });
  });

  it.each(["active", "backlog"] as const)("keeps a hidden %s ancestor opaque while evaluating selected-project readiness", (status) => {
    const owner = handle.db.insert(schema.members).values({ name: "Owner", color: "#111111" }).returning().get();
    const viewer = handle.db.insert(schema.members).values({ name: "Viewer", color: "#222222" }).returning().get();
    const ancestor = insertTestProject(handle.db, { title: "Hidden", scope: "work", ownerMemberId: owner.id, status });
    const project = insertTestProject(handle.db, { title: "Visible", parentId: ancestor.id, scope: "work", ownerMemberId: viewer.id });
    const action = insertTestTask(handle.db, { title: "Visible action", projectId: project.id, scope: "work" });
    const graph = Graph.load(handle.db, "2027-01-01", viewer.id, "2027-01-01T12:00:00.000Z");

    expect(graph.projectsById.has(ancestor.id)).toBe(false);
    expect(graph.tasksById.has(action.id)).toBe(true);
    expect(graph.effectiveDeferralFor(project.id)).toBeNull();
    expect(graph.effectiveDeferralFor(action.id)).toBeNull();
    expect(graph.isEffectivelyDeferred(action.id)).toBe(true);
    expect(graph.projectsById.get(project.id)?.activationReadiness).toMatchObject({ hasViableProgressPath: true });
  });
});

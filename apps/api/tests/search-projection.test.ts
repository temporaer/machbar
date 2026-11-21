import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import { createProject } from "../src/domain/storyCrud.js";
import { createChildTask, createTask } from "../src/domain/taskCrud.js";
import { searchTaskRecords, searchTasks } from "../src/domain/search.js";
import type { SearchFilters } from "@machbar/shared";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("search task projection", () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestContext(); });
  afterEach(async () => { await closeTestContext(ctx); });

  it("matches the full Graph search projection for filters, inheritance, hierarchy, terminal work, and viewers", async () => {
    const member = (name: string) => ctx.handle.db.insert(schema.members)
      .values({ name, color: "#334455" }).returning().get();
    const alice = member("Search Alice");
    const bob = member("Search Bob");
    const inheritedTag = (await ctx.app.inject({ method: "POST", url: "/api/tags", payload: { name: "Inherited search" } })).json<{ id: number }>();
    const explicitTag = (await ctx.app.inject({ method: "POST", url: "/api/tags", payload: { name: "Explicit search" } })).json<{ id: number }>();

    const ownedProject = createProject(ctx.handle.db, {
      title: "Private inherited project", scope: "work", ownerMemberId: alice.id,
      tagIds: [inheritedTag.id],
    });
    const root = createTask(ctx.handle.db, {
      projectId: ownedProject.id, title: "Öl Werkzeug reparieren", notes: "Ordnungsamt Termin vorbereiten",
    });
    const explicitChild = createChildTask(ctx.handle.db, root.id, {
      title: "Werkzeug Kind erledigen", notes: "Kellerkran prüfen",
    });
    const disabledGrandchild = createChildTask(ctx.handle.db, explicitChild.id, {
      title: "Werkzeug ohne Besitzer", notes: "Kellerkran Ersatzteil",
    });
    ctx.handle.db.update(schema.workItems).set({ ownerMemberId: bob.id, ownerInheritanceMode: "explicit" })
      .where(eq(schema.workItems.id, explicitChild.id)).run();
    ctx.handle.db.insert(schema.workItemTags).values({ workItemId: explicitChild.id, tagId: explicitTag.id }).run();
    ctx.handle.db.update(schema.workItems).set({ ownerMemberId: null, ownerInheritanceMode: "none" })
      .where(eq(schema.workItems.id, disabledGrandchild.id)).run();
    ctx.handle.db.insert(schema.taskExcludedTags).values({ taskId: disabledGrandchild.id, tagId: inheritedTag.id }).run();
    ctx.handle.db.update(schema.workItems).set({ status: "done" }).where(eq(schema.workItems.id, explicitChild.id)).run();

    const publicTask = createTask(ctx.handle.db, {
      title: "Werkzeug öffentliche Aufgabe", notes: "Ordnungsamt Suche",
    });
    const publicChild = createChildTask(ctx.handle.db, publicTask.id, {
      title: "Werkzeug öffentliche Teilaufgabe",
    });
    const privateProject = createProject(ctx.handle.db, {
      title: "Bob private project", scope: "work", ownerMemberId: bob.id,
    });
    const bobPrivate = createTask(ctx.handle.db, { projectId: privateProject.id, title: "Werkzeug Bob confidential" });
    const alicePrivate = createTask(ctx.handle.db, { projectId: privateProject.id, title: "Werkzeug Alice private" });
    ctx.handle.db.update(schema.workItems).set({ privacyOwnerMemberId: alice.id })
      .where(eq(schema.workItems.id, alicePrivate.id)).run();

    const externalWait = createTask(ctx.handle.db, { title: "Werkzeug waiting on supplier" });
    ctx.handle.db.insert(schema.taskExternalWaits).values({ taskId: externalWait.id, waitingFor: "Supplier" }).run();
    ctx.handle.db.insert(schema.taskDependencies).values({ taskId: publicTask.id, dependsOnTaskId: externalWait.id }).run();

    const filterSets: SearchFilters[] = [
      { text: "werkzeug ordnungsamt", includeTerminal: true },
      { text: "KELLERKRAN", includeTerminal: true },
      { ownerId: alice.id, includeTerminal: true },
      { ownerId: bob.id, tagIds: [inheritedTag.id], includeTerminal: true },
      { tagIds: [inheritedTag.id, explicitTag.id], includeTerminal: true },
      { blocked: true, includeTerminal: true },
      { externalWait: true, includeTerminal: true },
      { status: "done" },
      { projectId: ownedProject.id, kinds: ["action"], includeTerminal: true },
    ];

    for (const viewerId of [undefined, alice.id, bob.id]) {
      const graph = Graph.load(ctx.handle.db, undefined, viewerId);
      const projectedTasks = Graph.loadSearchTasks(ctx.handle.db, viewerId);
      for (const filters of filterSets) {
        expect(searchTaskRecords(projectedTasks, filters)).toEqual(searchTasks(graph, filters));
      }
    }

    const aliceResults = searchTaskRecords(Graph.loadSearchTasks(ctx.handle.db, alice.id), { text: "confidential" });
    expect(aliceResults.map((task) => task.id)).not.toContain(bobPrivate.id);
    expect(aliceResults.map((task) => task.title)).not.toContain("Werkzeug Bob confidential");
    expect(searchTaskRecords(Graph.loadSearchTasks(ctx.handle.db, bob.id), { text: "confidential" }).map((task) => task.id))
      .toContain(bobPrivate.id);

    const hierarchyResults = searchTaskRecords(Graph.loadSearchTasks(ctx.handle.db, alice.id), {
      text: "Werkzeug", includeTerminal: true,
    });
    const returnedRoot = hierarchyResults.find((task) => task.id === publicTask.id)!;
    expect(returnedRoot.children.map((task) => task.id)).toContain(publicChild.id);
  });
});

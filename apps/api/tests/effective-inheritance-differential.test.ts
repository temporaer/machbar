import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { Graph } from "../src/domain/graph.js";
import type { Db } from "../src/db/client.js";
import {
  getEffectiveOwners,
  getEffectivePhysicalContextIds,
  getEffectiveTagIds,
} from "../src/repo/effectiveRepo.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

type LegacyOwner = {
  taskId: number;
  ownerId: number | null;
  ownerSource: "task" | "parent" | "project" | "none";
};

function legacyEffectiveProjection(db: Db) {
  const owners = db.all<{
    task_id: number;
    owner_id: number | null;
    owner_source: LegacyOwner["ownerSource"];
  }>(sql`
    WITH RECURSIVE eff(task_id, owner_id, owner_source) AS (
      SELECT
        t.id,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN t.owner_member_id
          WHEN t.owner_inheritance_mode = 'none' THEN NULL
          ELSE story.owner_member_id
        END,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN 'task'
          WHEN t.owner_inheritance_mode = 'none' THEN 'none'
          WHEN story.owner_member_id IS NOT NULL THEN 'project'
          ELSE 'none'
        END
      FROM work_items t
      LEFT JOIN work_items story ON story.id = t.parent_id AND story.role = 'story'
      WHERE t.role = 'task'
        AND (t.parent_id IS NULL OR story.id IS NOT NULL)

      UNION ALL

      SELECT
        t.id,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN t.owner_member_id
          WHEN t.owner_inheritance_mode = 'none' THEN NULL
          ELSE eff.owner_id
        END,
        CASE
          WHEN t.owner_inheritance_mode = 'explicit' THEN 'task'
          WHEN t.owner_inheritance_mode = 'none' THEN 'none'
          WHEN eff.owner_source = 'none' THEN 'none'
          WHEN eff.owner_source = 'project' THEN 'project'
          ELSE 'parent'
        END
      FROM work_items t
      JOIN eff ON t.parent_id = eff.task_id
      WHERE t.role = 'task'
    )
    SELECT task_id, owner_id, owner_source FROM eff
  `);

  const tags = db.all<{ task_id: number; effective_json: string }>(sql`
    WITH RECURSIVE tag_state(task_id, effective_json) AS (
      SELECT
        t.id,
        (
          SELECT json_group_array(tag_id) FROM (
            SELECT story_tags.tag_id AS tag_id FROM work_item_tags story_tags
            WHERE story_tags.work_item_id = story.id
              AND story_tags.tag_id NOT IN (SELECT tag_id FROM task_excluded_tags WHERE task_id = t.id)
            UNION
            SELECT task_tags.tag_id FROM work_item_tags task_tags WHERE task_tags.work_item_id = t.id
          )
        )
      FROM work_items t
      LEFT JOIN work_items story ON story.id = t.parent_id AND story.role = 'story'
      WHERE t.role = 'task'
        AND (t.parent_id IS NULL OR story.id IS NOT NULL)

      UNION ALL

      SELECT
        t.id,
        (
          SELECT json_group_array(tag_id) FROM (
            SELECT je.value AS tag_id FROM json_each(ts.effective_json) je
            WHERE je.value NOT IN (SELECT tag_id FROM task_excluded_tags WHERE task_id = t.id)
            UNION
            SELECT task_tags.tag_id FROM work_item_tags task_tags WHERE task_tags.work_item_id = t.id
          )
        )
      FROM work_items t
      JOIN tag_state ts ON t.parent_id = ts.task_id
      WHERE t.role = 'task'
    )
    SELECT task_id, effective_json FROM tag_state
  `);

  const contexts = db.all<{ task_id: number; effective_json: string }>(sql`
    WITH RECURSIVE context_state(task_id, effective_json) AS (
      SELECT
        t.id,
        CASE t.physical_context_inheritance_mode
          WHEN 'none' THEN json('[]')
          WHEN 'explicit' THEN (
            SELECT json_group_array(context_id)
            FROM work_item_physical_contexts
            WHERE work_item_id = t.id
          )
          ELSE (
            SELECT json_group_array(context_id)
            FROM work_item_physical_contexts
            WHERE work_item_id = story.id
          )
        END
      FROM work_items t
      LEFT JOIN work_items story ON story.id = t.parent_id AND story.role = 'story'
      WHERE t.role = 'task'
        AND (t.parent_id IS NULL OR story.id IS NOT NULL)

      UNION ALL

      SELECT
        t.id,
        CASE t.physical_context_inheritance_mode
          WHEN 'none' THEN json('[]')
          WHEN 'explicit' THEN (
            SELECT json_group_array(context_id)
            FROM work_item_physical_contexts
            WHERE work_item_id = t.id
          )
          ELSE parent.effective_json
        END
      FROM work_items t
      JOIN context_state parent ON t.parent_id = parent.task_id
      WHERE t.role = 'task'
    )
    SELECT task_id, effective_json FROM context_state
  `);

  return {
    owners: owners
      .map((row) => ({
        taskId: row.task_id,
        ownerId: row.owner_id,
        ownerSource: row.owner_source,
      }))
      .sort((a, b) => a.taskId - b.taskId),
    tags: tags
      .map((row) => ({
        taskId: row.task_id,
        tagIds: JSON.parse(row.effective_json) as number[],
      }))
      .sort((a, b) => a.taskId - b.taskId),
    contexts: contexts
      .map((row) => ({
        taskId: row.task_id,
        contextIds: JSON.parse(row.effective_json) as number[],
      }))
      .sort((a, b) => a.taskId - b.taskId),
  };
}

function optimizedProjection(db: Db) {
  return {
    owners: [...getEffectiveOwners(db)]
      .map(([taskId, owner]) => ({ taskId, ownerId: owner.ownerId, ownerSource: owner.ownerSource }))
      .sort((a, b) => a.taskId - b.taskId),
    tags: [...getEffectiveTagIds(db)]
      .map(([taskId, tagIds]) => ({ taskId, tagIds }))
      .sort((a, b) => a.taskId - b.taskId),
    contexts: [...getEffectivePhysicalContextIds(db)]
      .map(([taskId, contextIds]) => ({ taskId, contextIds }))
      .sort((a, b) => a.taskId - b.taskId),
  };
}

describe("effective inheritance query differential", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("preserves complete owner, tag, and context maps and viewer-filtered Graph projections", async () => {
    const member = (name: string) =>
      ctx.handle.db.insert(schema.members)
        .values({ name, color: "#334455" })
        .returning()
        .get();
    const ownerA = member("Owner A");
    const ownerB = member("Owner B");
    const tagA = (await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Inherited" },
    })).json();
    const tagB = (await ctx.app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Explicit" },
    })).json();
    const project = (await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "Inheritance fixture",
        scope: "work",
        ownerMemberId: ownerA.id,
        tagIds: [tagA.id],
      },
    })).json();
    const root = (await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId: project.id, title: "Inherited root" },
    })).json();
    const child = (await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${root.id}/children`,
      payload: { title: "Explicit child" },
    })).json();
    const grandchild = (await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/children`,
      payload: { title: "Disabled grandchild" },
    })).json();

    const contextA = ctx.handle.db.insert(schema.physicalContexts).values({
      source: "home_assistant",
      externalId: "inheritance-home",
      name: "Home",
    }).returning().get();
    const contextB = ctx.handle.db.insert(schema.physicalContexts).values({
      source: "home_assistant",
      externalId: "inheritance-office",
      name: "Office",
    }).returning().get();

    ctx.handle.db.insert(schema.workItemPhysicalContexts)
      .values({ workItemId: project.id, contextId: contextA.id }).run();
    ctx.handle.db.update(schema.workItems)
      .set({
        ownerMemberId: ownerB.id,
        ownerInheritanceMode: "explicit",
        physicalContextInheritanceMode: "explicit",
      })
      .where(eq(schema.workItems.id, child.id)).run();
    ctx.handle.db.insert(schema.workItemPhysicalContexts)
      .values({ workItemId: child.id, contextId: contextB.id }).run();
    ctx.handle.db.insert(schema.workItemTags)
      .values({ workItemId: child.id, tagId: tagB.id }).run();
    ctx.handle.db.update(schema.workItems)
      .set({
        ownerMemberId: null,
        ownerInheritanceMode: "none",
        physicalContextInheritanceMode: "none",
      })
      .where(eq(schema.workItems.id, grandchild.id)).run();
    ctx.handle.db.insert(schema.taskExcludedTags)
      .values({ taskId: grandchild.id, tagId: tagA.id }).run();

    const expected = legacyEffectiveProjection(ctx.handle.db);
    expect(optimizedProjection(ctx.handle.db)).toEqual(expected);

    const ownerById = new Map(expected.owners.map((row) => [row.taskId, row]));
    const tagsById = new Map(expected.tags.map((row) => [row.taskId, row.tagIds]));
    const contextsById = new Map(expected.contexts.map((row) => [row.taskId, row.contextIds]));
    expect(ownerById.get(root.id)).toMatchObject({ ownerId: ownerA.id, ownerSource: "project" });
    expect(ownerById.get(child.id)).toMatchObject({ ownerId: ownerB.id, ownerSource: "task" });
    expect(ownerById.get(grandchild.id)).toMatchObject({ ownerId: null, ownerSource: "none" });
    expect(tagsById.get(root.id)).toEqual([tagA.id]);
    expect(tagsById.get(child.id)).toEqual([tagA.id, tagB.id].sort((a, b) => a - b));
    expect(tagsById.get(grandchild.id)).toEqual([tagB.id]);
    expect(contextsById.get(root.id)).toEqual([contextA.id]);
    expect(contextsById.get(child.id)).toEqual([contextB.id]);
    expect(contextsById.get(grandchild.id)).toEqual([]);

    for (const viewer of [undefined, ownerA.id, ownerB.id]) {
      const graph = viewer === undefined
        ? Graph.load(ctx.handle.db)
        : Graph.load(ctx.handle.db, undefined, viewer);
      for (const task of graph.tasksById.values()) {
        const owner = ownerById.get(task.id)!;
        expect(task.effectiveOwnerId).toBe(owner.ownerId);
        expect(task.effectiveOwnerSource).toBe(owner.ownerSource);
        expect(task.effectiveTags.map((tag) => tag.id)).toEqual(tagsById.get(task.id));
        expect(task.effectiveContexts.map((context) => context.id)).toEqual(contextsById.get(task.id));
      }
    }

    expect([...Graph.load(ctx.handle.db).tasksById.keys()]).toEqual(
      expect.arrayContaining([root.id, child.id, grandchild.id]),
    );
    expect([...Graph.load(ctx.handle.db, undefined, ownerA.id).tasksById.keys()]).toContain(root.id);
    expect([...Graph.load(ctx.handle.db, undefined, ownerA.id).tasksById.keys()]).not.toContain(child.id);
    expect([...Graph.load(ctx.handle.db, undefined, ownerB.id).tasksById.keys()]).toContain(child.id);
    expect([...Graph.load(ctx.handle.db, undefined, ownerB.id).tasksById.keys()]).not.toContain(root.id);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  addCriterion,
  createProject,
  removeCriterion,
  reorderCriteria,
  setCriterionChecked,
  updateCriterionText,
} from "../src/domain/mutations.js";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

/**
 * Route-level (HTTP) coverage of the structured, ordered acceptance
 * criteria that replaced `Project.description`: add / edit / reorder /
 * check / remove, each transactional and scoped to its project.
 */
describe("project acceptance criteria (HTTP routes)", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createProjectRoute() {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Kriterien-Projekt" },
    });
    return res.json();
  }

  it("adds criteria in order, exposed as Project.acceptanceCriteria", async () => {
    const project = await createProjectRoute();

    const first = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text: "Erstes Kriterium" },
      })
    ).json();
    expect(first.acceptanceCriteria).toHaveLength(1);
    expect(first.acceptanceCriteria[0]).toMatchObject({
      text: "Erstes Kriterium",
      checked: false,
      position: 0,
    });

    const second = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text: "Zweites Kriterium" },
      })
    ).json();
    expect(second.acceptanceCriteria.map((c: { text: string }) => c.text)).toEqual([
      "Erstes Kriterium",
      "Zweites Kriterium",
    ]);
    expect(second.acceptanceCriteria[1].position).toBe(1);
  });

  it("rejects an empty criterion text with a stable code", async () => {
    const project = await createProjectRoute();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("acceptance_criterion_text_required");
  });

  it("edits a criterion's text without touching its checked state or position", async () => {
    const project = await createProjectRoute();
    const added = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text: "Ursprünglich" },
      })
    ).json();
    const criterionId = added.acceptanceCriteria[0].id;

    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
      payload: { checked: true },
    });

    const edited = (
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/criteria/${criterionId}`,
        payload: { text: "Bearbeitet" },
      })
    ).json();
    expect(edited.acceptanceCriteria[0]).toMatchObject({
      text: "Bearbeitet",
      checked: true,
      position: 0,
    });
  });

  it("checks and unchecks a criterion", async () => {
    const project = await createProjectRoute();
    const added = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text: "Zu prüfen" },
      })
    ).json();
    const criterionId = added.acceptanceCriteria[0].id;

    const checked = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
        payload: { checked: true },
      })
    ).json();
    expect(checked.acceptanceCriteria[0].checked).toBe(true);

    const unchecked = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria/${criterionId}/check`,
        payload: { checked: false },
      })
    ).json();
    expect(unchecked.acceptanceCriteria[0].checked).toBe(false);
  });

  it("reorders criteria to an explicit new order", async () => {
    const project = await createProjectRoute();
    const texts = ["A", "B", "C"];
    for (const text of texts) {
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text },
      });
    }
    const before = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json();
    const [a, b, c] = before.acceptanceCriteria;

    const reordered = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria/reorder`,
        payload: { orderedCriterionIds: [c.id, a.id, b.id] },
      })
    ).json();
    expect(reordered.acceptanceCriteria.map((cr: { text: string }) => cr.text)).toEqual([
      "C",
      "A",
      "B",
    ]);
    expect(reordered.acceptanceCriteria.map((cr: { position: number }) => cr.position)).toEqual([
      0, 1, 2,
    ]);
  });

  it("rejects reordering with a mismatched id set", async () => {
    const project = await createProjectRoute();
    await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria`,
      payload: { text: "Einziges" },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/criteria/reorder`,
      payload: { orderedCriterionIds: [999999] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "acceptance_criteria_order_invalid",
      details: {
        projectId: project.id,
        requestedCriterionIds: [999999],
      },
    });
  });

  it("removes a criterion and compacts the remaining positions", async () => {
    const project = await createProjectRoute();
    const texts = ["A", "B", "C"];
    for (const text of texts) {
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/criteria`,
        payload: { text },
      });
    }
    const before = (
      await ctx.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json();
    const [a, b] = before.acceptanceCriteria;

    const afterDelete = (
      await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}/criteria/${a.id}`,
      })
    ).json();
    expect(afterDelete.acceptanceCriteria.map((cr: { text: string }) => cr.text)).toEqual([
      "B",
      "C",
    ]);
    expect(afterDelete.acceptanceCriteria.map((cr: { position: number }) => cr.position)).toEqual([
      0, 1,
    ]);
    expect(afterDelete.acceptanceCriteria[0].id).toBe(b.id);
  });

  it("returns a structured 404 for a criterion id outside the project", async () => {
    const projectA = await createProjectRoute();
    const projectB = await createProjectRoute();
    const added = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${projectA.id}/criteria`,
        payload: { text: "Gehört zu A" },
      })
    ).json();
    const criterionId = added.acceptanceCriteria[0].id;

    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/projects/${projectB.id}/criteria/${criterionId}`,
      payload: { text: "Fremdzugriff" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      code: "acceptance_criterion_not_found",
      details: { projectId: projectB.id, criterionId },
    });
  });
});

/**
 * Service-level (direct mutation function) coverage: transactional
 * guarantees and edge cases around ordering/deletion that are simplest to
 * assert directly against the mutation functions.
 */
describe("project acceptance criteria (service layer)", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
    runMigrations(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("trims criterion text on add and on edit", () => {
    const project = createProject(handle.db, { title: "Projekt" });
    const criterion = addCriterion(handle.db, project.id, "  Mit Leerzeichen  ");
    expect(criterion.text).toBe("Mit Leerzeichen");

    const edited = updateCriterionText(handle.db, project.id, criterion.id, "  Neuer Text  ");
    expect(edited.text).toBe("Neuer Text");
  });

  it("rejects adding/editing with blank text", () => {
    const project = createProject(handle.db, { title: "Projekt" });
    expect(() => addCriterion(handle.db, project.id, "   ")).toThrow(/must not be empty/);

    const criterion = addCriterion(handle.db, project.id, "Gültig");
    expect(() => updateCriterionText(handle.db, project.id, criterion.id, "")).toThrow(
      /must not be empty/,
    );
  });

  it("throws not-found for a criterion id from a different project", () => {
    const projectA = createProject(handle.db, { title: "A" });
    const projectB = createProject(handle.db, { title: "B" });
    const criterion = addCriterion(handle.db, projectA.id, "Gehört zu A");

    expect(() => setCriterionChecked(handle.db, projectB.id, criterion.id, true)).toThrow(
      /not found/,
    );
    expect(() => removeCriterion(handle.db, projectB.id, criterion.id)).toThrow(
      /not found/,
    );
  });

  it("rejects reordering that omits, duplicates or adds a foreign id", () => {
    const project = createProject(handle.db, { title: "Projekt" });
    const a = addCriterion(handle.db, project.id, "A");
    const b = addCriterion(handle.db, project.id, "B");

    expect(() => reorderCriteria(handle.db, project.id, [a.id])).toThrow(
      /every existing criterion exactly once/,
    );
    expect(() => reorderCriteria(handle.db, project.id, [a.id, a.id])).toThrow(
      /every existing criterion exactly once/,
    );
    expect(() => reorderCriteria(handle.db, project.id, [a.id, b.id, 999999])).toThrow(
      /every existing criterion exactly once/,
    );
  });

  it("never leaves a gap in positions after removing a criterion from the middle", () => {
    const project = createProject(handle.db, { title: "Projekt" });
    const a = addCriterion(handle.db, project.id, "A");
    const b = addCriterion(handle.db, project.id, "B");
    const c = addCriterion(handle.db, project.id, "C");

    removeCriterion(handle.db, project.id, b.id);

    const remaining = reorderCriteria(handle.db, project.id, [a.id, c.id]);
    expect(remaining.map((cr) => cr.position)).toEqual([0, 1]);
  });
});

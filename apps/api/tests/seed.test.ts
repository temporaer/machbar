import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

describe("seed data", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext({ seed: true });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  it("seeds three members and the standard tag catalogue", async () => {
    const members = await ctx.app.inject({ method: "GET", url: "/api/members" });
    expect(members.json()).toHaveLength(3);

    const tags = await ctx.app.inject({ method: "GET", url: "/api/tags" });
    const tagNames = tags.json().map((tag: { name: string }) => tag.name);
    expect(tagNames).toEqual(
      expect.arrayContaining([
        "Lars",
        "Lea",
        "Jonas",
        "Hannes",
        "Sarah",
        "Schule",
        "Kita",
        "Urlaub",
        "Haus",
        "Garten",
      ]),
    );
  });

  it("derives the consolidated Review queue without obsolete unassigned debt", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/review" });
    expect(res.statusCode).toBe(200);
    const review = res.json() as Array<{
      entityTitle: string;
      projectTitle: string | null;
      reason: string;
    }>;
    expect(review).toContainEqual(
      expect.objectContaining({
        projectTitle: "Küche renovieren",
        reason: "no_viable_progress_path",
      }),
    );
    expect(review).toContainEqual(
      expect.objectContaining({
        projectTitle: "Wartungsplan Auto",
        reason: "waiting_without_followup",
      }),
    );
    expect(
      review.some(
        (item) =>
          item.projectTitle === "Steuererklärung 2025" &&
          item.reason === "unassigned_actionable",
      ),
    ).toBe(false);
  });

  it("computes a next action for healthy projects", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects" });
    const projects = res.json() as Array<{ title: string; nextAction: { title: string } | null }>;
    const umzug = projects.find((p) => p.title === "Umzug nach Leipzig")!;
    expect(umzug.nextAction?.title).toBe("Umzugsunternehmen beauftragen");
  });

  it("lists the Eingang (inbox) items", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/inbox" });
    const titles = res.json().map((t: { title: string }) => t.title);
    expect(titles).toContain("Zahnarzttermin ausmachen");
    expect(titles).toContain("Ummeldung Wohnsitz");
  });

  it("lists externally blocked work with structured wait context", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    const tasks = res.json() as Array<{
      title: string;
      externalWait: { waitingFor: string | null } | null;
    }>;
    expect(tasks).toContainEqual(
      expect.objectContaining({
        title: "Nebenkostenabrechnung klären",
        externalWait: { waitingFor: "Vermieter" },
      }),
    );
  });

  it("builds the Heute agenda without duplicate tasks across sections", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    const agenda = res.json();
    const allIds = [
      ...agenda.planned,
      ...agenda.overdue,
      ...agenda.dueToday,
      ...agenda.dueSoon,
      ...agenda.shared,
      ...agenda.revisit,
    ].map((t: { id: number }) => t.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(agenda.planned.map((t: { title: string }) => t.title)).toContain(
      "Kartons besorgen",
    );
  });

  it("surfaces the blocked-but-scheduled-for-today seed task as a revisit reminder", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    const agenda = res.json();
    const revisitTitles = agenda.revisit.map((t: { title: string }) => t.title);
    expect(revisitTitles).toContain("Leiter zurückbringen");
    const revisitTask = agenda.revisit.find(
      (t: { title: string }) => t.title === "Leiter zurückbringen",
    );
    expect(revisitTask.blocked).toBe(true);
    // It must never also show up in one of the "normal" buckets.
    for (const key of ["planned", "overdue", "dueToday", "dueSoon", "shared"] as const) {
      expect(
        agenda[key].some((t: { title: string }) => t.title === "Leiter zurückbringen"),
      ).toBe(false);
    }
  });
});

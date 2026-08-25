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

  it("classifies every Festgefahren scenario correctly", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects/stuck" });
    expect(res.statusCode).toBe(200);
    const byTitle = Object.fromEntries(
      res.json().map((p: { title: string; stuckReason: string }) => [p.title, p.stuckReason]),
    );
    expect(byTitle["Steuererklärung 2025"]).toBe("unassigned_actionable");
    expect(byTitle["Küche renovieren"]).toBe("no_next_action");
    expect(byTitle["Wartungsplan Auto"]).toBe(
      "only_waiting_without_followup",
    );
    expect(byTitle["Bücherregal aufbauen"]).toBe("blocked_dependencies");
    expect(byTitle["Umzug nach Leipzig"]).toBeUndefined();
    expect(byTitle["Garten winterfest machen"]).toBeUndefined();
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

  it("groups Wartet tasks by waitingFor", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/waiting" });
    const groups = res.json() as Array<{ waitingFor: string; tasks: unknown[] }>;
    const vermieter = groups.find((g) => g.waitingFor === "Vermieter");
    expect(vermieter?.tasks).toHaveLength(1);
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const monday = "2026-09-07";
const tuesday = "2026-09-08";
const wednesday = "2026-09-09";
const friday = "2026-09-11";
const nextMonday = "2026-09-14";

describe("week planning agenda", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createProject(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function getWeek() {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/week?start=${monday}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  function titles(items: Array<{ title: string }>) {
    return items.map((item) => item.title);
  }

  it("groups the requested seven-day window", async () => {
    const week = await getWeek();

    expect(week.start).toBe(monday);
    expect(week.end).toBe("2026-09-13");
    expect(week.days.map((day: { date: string }) => day.date)).toEqual([
      monday,
      tuesday,
      wednesday,
      "2026-09-10",
      friday,
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("places scheduled tasks and stories on their own scheduled day", async () => {
    await createTask({ title: "Apotheke abholen", scheduledDate: tuesday });
    await createProject({
      title: "Urlaub planen",
      scheduledDate: wednesday,
    });

    const week = await getWeek();

    expect(titles(week.days[1].items)).toContain("Apotheke abholen");
    expect(titles(week.days[2].items)).toContain("Urlaub planen");
  });

  it("keeps due-only items distinct from scheduled planning", async () => {
    await createTask({
      title: "Steuerunterlagen",
      scheduledDate: wednesday,
      dueDate: friday,
    });
    await createTask({
      title: "Paketfrist",
      dueDate: friday,
    });

    const week = await getWeek();
    const scheduled = week.days[2].items.find(
      (item: { title: string }) => item.title === "Steuerunterlagen",
    );
    const dueOnly = week.days[4].items.find(
      (item: { title: string }) => item.title === "Paketfrist",
    );

    expect(scheduled).toMatchObject({
      title: "Steuerunterlagen",
      placement: "scheduled",
      scheduledDate: wednesday,
      dueDate: friday,
    });
    expect(dueOnly).toMatchObject({
      title: "Paketfrist",
      placement: "due",
      scheduledDate: null,
      dueDate: friday,
    });
    expect(titles(week.days[4].items)).not.toContain("Steuerunterlagen");
  });

  it("puts unscheduled actionable work in the planning pool", async () => {
    await createTask({ title: "Versicherung anrufen", dueDate: nextMonday });

    const week = await getWeek();

    expect(titles(week.unplanned)).toContain("Versicherung anrufen");
  });

  it("does not propagate a story date to descendant tasks", async () => {
    const story = await createProject({
      title: "Haus verbessern",
      scheduledDate: monday,
    });
    await createTask({
      title: "Rauchmelder kaufen",
      projectId: story.id,
    });

    const week = await getWeek();

    expect(titles(week.days[0].items)).toContain("Haus verbessern");
    expect(titles(week.days[0].items)).not.toContain("Rauchmelder kaufen");
  });
});

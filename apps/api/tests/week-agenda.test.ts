import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

const monday = "2026-09-07";
const tuesday = "2026-09-08";
const wednesday = "2026-09-09";
const thursday = "2026-09-10";
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

  async function setExternalWait(task: { id: number; revision: number }, payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/external-wait`,
      payload: { expectedRevision: task.revision, ...payload },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function addDependency(task: { id: number }, dependsOnTaskId: number) {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/dependencies`,
      payload: { dependsOnTaskId },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function getTask(id: number) {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
    });
    expect(res.statusCode).toBe(200);
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

  it("places a task with a revisit date inside the week on that day as a revisit", async () => {
    const task = await createTask({ title: "Handwerker nachfragen" });
    await setExternalWait(task, {
      waitingFor: "Handwerker",
      revisitDate: wednesday,
    });

    const week = await getWeek();
    const item = week.days[2].items.find(
      (entry: { title: string }) => entry.title === "Handwerker nachfragen",
    );

    expect(item).toMatchObject({
      title: "Handwerker nachfragen",
      placement: "revisit",
      externalWait: { waitingFor: "Handwerker", revisitDate: wednesday },
    });
  });

  it("prefers the revisit date over the due date when both fall within the week", async () => {
    const task = await createTask({
      title: "Angebot einholen",
      dueDate: friday,
    });
    await setExternalWait(task, {
      waitingFor: "Anbieter",
      revisitDate: tuesday,
    });

    const week = await getWeek();
    const onRevisitDay = week.days[1].items.find(
      (entry: { title: string }) => entry.title === "Angebot einholen",
    );
    const onDueDay = week.days[4].items.find(
      (entry: { title: string }) => entry.title === "Angebot einholen",
    );

    expect(onRevisitDay).toMatchObject({
      placement: "revisit",
      externalWait: { waitingFor: "Anbieter", revisitDate: tuesday },
      dueDate: friday,
    });
    expect(onDueDay).toBeUndefined();
  });

  it("falls back to the due date placement when a waiting task has no revisit date", async () => {
    const task = await createTask({
      title: "Rueckmeldung abwarten",
      dueDate: friday,
    });
    await setExternalWait(task, { waitingFor: "Behoerde" });

    const week = await getWeek();
    const item = week.days[4].items.find(
      (entry: { title: string }) => entry.title === "Rueckmeldung abwarten",
    );

    expect(item).toMatchObject({
      title: "Rueckmeldung abwarten",
      placement: "due",
      externalWait: { waitingFor: "Behoerde", revisitDate: null },
    });
    expect(titles(week.unplanned)).not.toContain("Rueckmeldung abwarten");
  });

  it("omits a waiting task from the week entirely when it has neither a revisit nor a due date in range", async () => {
    const task = await createTask({ title: "Antwort ausstehend" });
    await setExternalWait(task, { waitingFor: "Kollege" });

    const week = await getWeek();

    for (const day of week.days) {
      expect(titles(day.items)).not.toContain("Antwort ausstehend");
    }
    expect(titles(week.unplanned)).not.toContain("Antwort ausstehend");
  });

  it("never places a waiting task in the unplanned pool", async () => {
    const dueOutsideWeek = await createTask({
      title: "Spaeter faellig",
      dueDate: nextMonday,
    });
    await setExternalWait(dueOutsideWeek, { waitingFor: "Zulieferer" });

    const week = await getWeek();

    expect(titles(week.unplanned)).not.toContain("Spaeter faellig");
  });

  it("does not let a dependency-blocked task inherit its blocker's revisit date", async () => {
    const blocker = await createTask({ title: "Genehmigung abwarten" });
    await setExternalWait(blocker, {
      waitingFor: "Behoerde",
      revisitDate: wednesday,
    });
    const blocked = await createTask({ title: "Umbau starten" });
    await addDependency(blocked, blocker.id);

    const blockedTask = await getTask(blocked.id);
    expect(blockedTask.nextBlockerAttentionDate).toBe(wednesday);
    expect(blockedTask.externalWait).toBeNull();

    const week = await getWeek();

    expect(titles(week.days[2].items)).not.toContain("Umbau starten");
    for (const day of week.days) {
      expect(titles(day.items)).not.toContain("Umbau starten");
    }
    expect(titles(week.unplanned)).not.toContain("Umbau starten");
  });

  it("keeps ordinary actionable task placement unaffected by revisit handling", async () => {
    await createTask({ title: "Rasen maehen", scheduledDate: tuesday });
    await createTask({ title: "Rechnung bezahlen", dueDate: friday });

    const week = await getWeek();
    const scheduled = week.days[1].items.find(
      (entry: { title: string }) => entry.title === "Rasen maehen",
    );
    const due = week.days[4].items.find(
      (entry: { title: string }) => entry.title === "Rechnung bezahlen",
    );

    expect(scheduled).toMatchObject({ placement: "scheduled", externalWait: null });
    expect(due).toMatchObject({ placement: "due", externalWait: null });
  });

  it("keeps ordinary story placement unaffected by revisit handling", async () => {
    await createProject({ title: "Kueche renovieren", scheduledDate: thursday });

    const week = await getWeek();
    const story = week.days[3].items.find(
      (entry: { title: string }) => entry.title === "Kueche renovieren",
    );

    expect(story).toMatchObject({ role: "story", placement: "scheduled" });
  });
});

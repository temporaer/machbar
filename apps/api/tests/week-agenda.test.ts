import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";
import { Graph } from "../src/domain/graph.js";
import { buildWeekAgenda } from "../src/domain/weekAgenda.js";

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

  async function createMember(name: string) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name },
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

  function activateProject(project: { id: number }) {
    ctx.handle.sqlite
      .prepare("UPDATE work_items SET status = 'active' WHERE id = ?")
      .run(project.id);
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

  it("places explicitly dated tasks from backlog stories without adding their unscheduled siblings to the planning pool", async () => {
    const story = await createProject({ title: "All-Hands planen" });
    const scheduled = await createTask({
      title: "Fuer All-Hands anmelden",
      projectId: story.id,
      scheduledDate: tuesday,
    });
    await createTask({
      title: "Unterkunft irgendwann klaeren",
      projectId: story.id,
    });
    const waiting = await createTask({
      title: "Biggi nach Reise fragen",
      projectId: story.id,
    });
    await setExternalWait(waiting, {
      waitingFor: "Biggi",
      revisitDate: wednesday,
    });

    const week = await getWeek();

    expect(week.days[1].items).toContainEqual(
      expect.objectContaining({
        id: scheduled.id,
        title: "Fuer All-Hands anmelden",
        placement: "scheduled",
        projectId: story.id,
        projectTitle: "All-Hands planen",
      }),
    );
    expect(week.days[2].items).toContainEqual(
      expect.objectContaining({
        id: waiting.id,
        title: "Biggi nach Reise fragen",
        placement: "revisit",
        externalWait: { waitingFor: "Biggi", revisitDate: wednesday },
      }),
    );
    expect(titles(week.unplanned)).not.toContain("Unterkunft irgendwann klaeren");
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

  it("derives unplanned from shared planning selection without current-context filtering", async () => {
    const story = await createProject({ title: "Kueche renovieren" });
    activateProject(story);
    await createTask({ title: "Elektriker anrufen", projectId: story.id });
    await createTask({ title: "Fliesen aussuchen", projectId: story.id });
    await createTask({ title: "Schrank montieren", projectId: story.id });
    await createTask({ title: "Standalone machbar" });
    await createTask({ title: "Schon geplant", scheduledDate: friday });
    await createTask({ title: "Someday", status: "someday" });
    await createTask({
      title: "Capture",
      status: "captured",
      needsClarification: true,
    });
    const waiting = await createTask({ title: "Antwort abwarten" });
    await setExternalWait(waiting, { waitingFor: "Extern" });
    const blocker = await createTask({ title: "Blocker" });
    const blocked = await createTask({ title: "Blockiert" });
    await addDependency(blocked, blocker.id);
    await createTask({ title: "Kontext anderswo" });

    const week = buildWeekAgenda(Graph.load(ctx.handle.db, monday), {
      start: monday,
      today: monday,
      contextAvailability: (task) =>
        task.title === "Kontext anderswo"
          ? {
              status: "unavailable",
              availableNow: false,
              missingContexts: [],
            }
          : {
              status: "available",
              availableNow: true,
              missingContexts: [],
            },
    });
    const unplannedTitles = titles(week.unplanned);

    expect(unplannedTitles).toContain("Standalone machbar");
    expect(unplannedTitles).toContain("Elektriker anrufen");
    expect(unplannedTitles).toContain("Kontext anderswo");
    expect(unplannedTitles).not.toContain("Fliesen aussuchen");
    expect(unplannedTitles).not.toContain("Schrank montieren");
    expect(unplannedTitles).not.toContain("Kueche renovieren");
    expect(unplannedTitles).not.toContain("Antwort abwarten");
    expect(unplannedTitles).not.toContain("Blockiert");
    expect(unplannedTitles).not.toContain("Capture");
    expect(unplannedTitles).not.toContain("Someday");
    expect(unplannedTitles).not.toContain("Schon geplant");
  });

  it("uses the shared member lane selection for project next actions", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    const story = await createProject({ title: "Lane story" });
    activateProject(story);
    await createTask({
      title: "Ben first",
      projectId: story.id,
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
    });
    await createTask({
      title: "Anna second",
      projectId: story.id,
      ownerMemberId: anna.id,
      ownerInheritanceMode: "explicit",
    });
    await createTask({
      title: "Shared third",
      projectId: story.id,
      ownerInheritanceMode: "none",
    });

    const week = buildWeekAgenda(Graph.load(ctx.handle.db, monday), {
      start: monday,
      today: monday,
      memberId: anna.id,
      scope: "mine",
    });
    const unplannedTitles = titles(week.unplanned);

    expect(unplannedTitles).toContain("Anna second");
    expect(unplannedTitles).not.toContain("Ben first");
    expect(unplannedTitles).not.toContain("Shared third");
  });

  it("keeps one unplanned project next action per owner lane in all scope", async () => {
    const anna = await createMember("Anna all");
    const ben = await createMember("Ben all");
    const story = await createProject({ title: "Parallel lanes" });
    activateProject(story);
    for (const [title, ownerMemberId, ownerInheritanceMode] of [
      ["Anna 1", anna.id, "explicit"],
      ["Anna 2", anna.id, "explicit"],
      ["Ben 1", ben.id, "explicit"],
      ["Shared 1", null, "none"],
      ["Shared 2", null, "none"],
    ] as const) {
      await createTask({
        title,
        projectId: story.id,
        ownerMemberId,
        ownerInheritanceMode,
      });
    }

    const week = buildWeekAgenda(Graph.load(ctx.handle.db, monday), {
      start: monday,
      today: monday,
      scope: "all",
    });
    const unplannedTitles = titles(week.unplanned);

    expect(unplannedTitles).toEqual(
      expect.arrayContaining(["Anna 1", "Ben 1", "Shared 1"]),
    );
    expect(unplannedTitles).not.toEqual(
      expect.arrayContaining(["Anna 2", "Shared 2"]),
    );
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

  it("uses exact dates for week placement without Today-style carry-over", async () => {
    const scheduled = await createTask({
      title: "Montag geplant",
      scheduledDate: monday,
    });
    const revisit = await createTask({ title: "Dienstag nachhaken" });
    await setExternalWait(revisit, {
      waitingFor: "Antwort",
      revisitDate: tuesday,
    });
    await createTask({ title: "Mittwoch faellig", dueDate: wednesday });
    await createTask({ title: "Vorwoche faellig", dueDate: "2026-09-05" });

    const week = await getWeek();

    expect(titles(week.days[0].items)).toContain(scheduled.title);
    expect(titles(week.days[1].items)).not.toContain(scheduled.title);
    expect(titles(week.days[1].items)).toContain("Dienstag nachhaken");
    expect(titles(week.days[2].items)).not.toContain("Dienstag nachhaken");
    expect(titles(week.days[2].items)).toContain("Mittwoch faellig");
    for (const day of week.days) {
      expect(titles(day.items)).not.toContain("Vorwoche faellig");
    }
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

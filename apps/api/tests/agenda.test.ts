import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("Heute agenda: query-derived planned + blocked revisit reminders", () => {
  let ctx: TestContext;
  const today = todayIso();
  const yesterday = addDaysIso(today, -1);
  const tomorrow = addDaysIso(today, 1);

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
    return res.json();
  }

  async function addDependency(taskId: number, dependsOnTaskId: number) {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dependencies`,
      payload: { dependsOnTaskId },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function getAgenda() {
    const res = await ctx.app.inject({ method: "GET", url: "/api/agenda/today" });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  function titlesOf(tasks: Array<{ title: string }>): string[] {
    return tasks.map((t) => t.title);
  }

  const bucketKeys = ["planned", "overdue", "dueToday", "dueSoon", "shared", "revisit"] as const;

  async function bucketsContaining(title: string) {
    const agenda = await getAgenda();
    return bucketKeys.filter((key) => titlesOf(agenda[key]).includes(title));
  }

  it("has no manual marked_today flag left on the task shape", async () => {
    const task = await createTask({ title: "Reine Query-Aufgabe" });
    expect(task).not.toHaveProperty("markedToday");
  });

  it("derives 'planned' purely from scheduledDate <= today (today and overdue-scheduled)", async () => {
    await createTask({ title: "Heute geplant", scheduledDate: today });
    await createTask({ title: "Gestern geplant, noch offen", scheduledDate: yesterday });
    await createTask({ title: "Erst morgen geplant", scheduledDate: tomorrow });

    const agenda = await getAgenda();
    const plannedTitles = titlesOf(agenda.planned);
    expect(plannedTitles).toContain("Heute geplant");
    expect(plannedTitles).toContain("Gestern geplant, noch offen");
    expect(plannedTitles).not.toContain("Erst morgen geplant");

    // The future-scheduled task doesn't land in planned (or any date-based
    // bucket) yet — being unowned and actionable, it does still show up
    // under "shared" until it's assigned or claimed.
    expect(await bucketsContaining("Erst morgen geplant")).toEqual(["shared"]);
  });

  it("excludes blocked tasks from every normal bucket, even when due today", async () => {
    const blocker = await createTask({ title: "Blockierer offen" });
    const blocked = await createTask({ title: "Blockierte Aufgabe fällig heute", dueDate: today });
    await addDependency(blocked.id, blocker.id);

    const foundIn = await bucketsContaining("Blockierte Aufgabe fällig heute");
    expect(foundIn).toEqual([]);
  });

  it("excludes a blocked task entirely when it has no scheduledDate of its own", async () => {
    const blocker = await createTask({ title: "Blockierer 2" });
    const blocked = await createTask({ title: "Blockiert ohne Termin" });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Blockiert ohne Termin")).toEqual([]);
  });

  it("excludes a blocked task whose own scheduledDate is still in the future", async () => {
    const blocker = await createTask({ title: "Blockierer 3" });
    const blocked = await createTask({
      title: "Blockiert, aber erst morgen geplant",
      scheduledDate: tomorrow,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Blockiert, aber erst morgen geplant")).toEqual([]);
  });

  it("surfaces a blocked task as a 'revisit' reminder when its own scheduledDate is today", async () => {
    const blocker = await createTask({ title: "Blockierer 4" });
    const blocked = await createTask({
      title: "Blockiert, heute zur Wiedervorlage",
      scheduledDate: today,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Blockiert, heute zur Wiedervorlage")).toEqual(["revisit"]);

    const agenda = await getAgenda();
    const revisitTask = agenda.revisit.find(
      (t: { title: string }) => t.title === "Blockiert, heute zur Wiedervorlage",
    );
    expect(revisitTask.blocked).toBe(true);
  });

  it("surfaces a blocked task as 'revisit' when its own scheduledDate is in the past (overdue-scheduled)", async () => {
    const blocker = await createTask({ title: "Blockierer 5" });
    const blocked = await createTask({
      title: "Blockiert, längst überfällig geplant",
      scheduledDate: yesterday,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Blockiert, längst überfällig geplant")).toEqual(["revisit"]);
  });

  it("does not inherit scheduledDate from the parent project for the revisit decision", async () => {
    const projectRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Projekt mit Termin", scheduledDate: today },
    });
    const project = projectRes.json();

    const blocker = await createTask({ title: "Blockierer 6" });
    const blocked = await createTask({
      title: "Aufgabe ohne eigenen Termin im terminierten Projekt",
      projectId: project.id,
    });
    await addDependency(blocked.id, blocker.id);

    // The project has a scheduledDate of today, but the task itself does
    // not — it must NOT reappear as a revisit item on the project's date.
    expect(
      await bucketsContaining("Aufgabe ohne eigenen Termin im terminierten Projekt"),
    ).toEqual([]);
  });

  it("moves a blocked-and-scheduled task out of revisit and into its normal bucket once unblocked", async () => {
    const blocker = await createTask({ title: "Blockierer 7" });
    const blocked = await createTask({
      title: "Wird später entblockt",
      scheduledDate: today,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Wird später entblockt")).toEqual(["revisit"]);

    await ctx.app.inject({ method: "POST", url: `/api/tasks/${blocker.id}/complete` });

    expect(await bucketsContaining("Wird später entblockt")).toEqual(["planned"]);
  });

  it("keeps every bucket, including revisit, mutually exclusive with no duplicate tasks", async () => {
    const blockerA = await createTask({ title: "Blockierer A" });
    const revisitTask = await createTask({
      title: "Revisit-Kandidat",
      scheduledDate: today,
      dueDate: today,
    });
    await addDependency(revisitTask.id, blockerA.id);

    await createTask({ title: "Ganz normal geplant", scheduledDate: today });
    await createTask({ title: "Überfällig", dueDate: yesterday });
    await createTask({ title: "Heute fällig", dueDate: today });
    await createTask({ title: "Bald fällig", dueDate: addDaysIso(today, 2) });
    await createTask({ title: "Gemeinsam offen" });

    const agenda = await getAgenda();
    const allIds = bucketKeys.flatMap((key) => agenda[key]).map((t: { id: number }) => t.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    // The blocked-and-scheduled-and-due task lands only in revisit, never
    // also in dueToday/planned because of its matching dueDate/scheduledDate.
    expect(await bucketsContaining("Revisit-Kandidat")).toEqual(["revisit"]);
  });
});

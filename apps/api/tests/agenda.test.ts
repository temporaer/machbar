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

  const bucketKeys = [
    "planned",
    "overdue",
    "dueToday",
    "dueSoon",
    "shared",
    "unscheduled",
    "followUp",
    "revisit",
  ] as const;

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
    // Future-planned work stays out of the current agenda entirely.
    expect(await bucketsContaining("Erst morgen geplant")).toEqual([]);
  });

  it("includes assigned actionable tasks without a scheduled date", async () => {
    const ownerRes = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Mira" },
    });
    const owner = ownerRes.json();
    await createTask({
      title: "Machbar ohne Termin",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
    });

    expect(await bucketsContaining("Machbar ohne Termin")).toEqual(["unscheduled"]);
  });

  it("excludes Später-klären captures from Heute", async () => {
    await createTask({
      title: "Noch zu entscheiden",
      needsClarification: true,
    });

    expect(await bucketsContaining("Noch zu entscheiden")).toEqual([]);
  });

  it("does not treat future-scheduled assigned work as unscheduled", async () => {
    const ownerRes = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Theo" },
    });

    const owner = ownerRes.json();
    await createTask({
      title: "Erst morgen für Theo",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: tomorrow,
    });

    expect(await bucketsContaining("Erst morgen für Theo")).toEqual([]);
  });

  it("puts due waiting follow-ups under Nachhaken and keeps future waits out", async () => {
    const blocker = await createTask({ title: "Offene Abhängigkeit" });
    const dueWaiting = await createTask({
      title: "Heute nachhaken",
      status: "waiting",
      scheduledDate: today,
    });
    await addDependency(dueWaiting.id, blocker.id);
    await createTask({
      title: "Später nachhaken",
      status: "waiting",
      scheduledDate: tomorrow,
    });

    expect(await bucketsContaining("Heute nachhaken")).toEqual(["followUp"]);
    expect(await bucketsContaining("Später nachhaken")).toEqual([]);
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

  it("excludes captured work from normal and revisit buckets", async () => {
    const blocker = await createTask({ title: "Capture-Blockierer" });
    const planned = await createTask({
      title: "Erfasst und geplant",
      scheduledDate: today,
    });
    const revisit = await createTask({
      title: "Erfasst und blockiert",
      scheduledDate: today,
    });
    await addDependency(revisit.id, blocker.id);
    ctx.handle.sqlite
      .prepare("UPDATE tasks SET status = 'captured', needs_clarification = 1 WHERE id IN (?, ?)")
      .run(planned.id, revisit.id);

    expect(await bucketsContaining("Erfasst und geplant")).toEqual([]);
    expect(await bucketsContaining("Erfasst und blockiert")).toEqual([]);
  });
});

describe("Heute agenda: filtering by selected member (effective owner)", () => {
  let ctx: TestContext;
  const today = todayIso();

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function createMember(name: string): Promise<{ id: number; name: string }> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createTask(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    return res.json();
  }

  async function createProject(payload: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload,
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

  async function getAgenda(memberId?: number) {
    const url =
      memberId === undefined ? "/api/agenda/today" : `/api/agenda/today?memberId=${memberId}`;
    const res = await ctx.app.inject({ method: "GET", url });
    return res;
  }

  function titlesOf(tasks: Array<{ title: string }>): string[] {
    return tasks.map((t) => t.title);
  }

  const bucketKeys = [
    "planned",
    "overdue",
    "dueToday",
    "dueSoon",
    "shared",
    "unscheduled",
    "revisit",
  ] as const;

  async function bucketsContaining(title: string, memberId?: number) {
    const res = await getAgenda(memberId);
    expect(res.statusCode).toBe(200);
    const agenda = res.json();
    return bucketKeys.filter((key) => titlesOf(agenda[key]).includes(title));
  }

  it("without a memberId, preserves the unfiltered all-household response (backward compatible)", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    await createTask({ title: "Annas Aufgabe heute", ownerMemberId: anna.id, ownerInheritanceMode: "explicit", scheduledDate: today });
    await createTask({ title: "Bens Aufgabe heute", ownerMemberId: ben.id, ownerInheritanceMode: "explicit", scheduledDate: today });
    await createTask({ title: "Gemeinsame Aufgabe heute", scheduledDate: today });

    const agenda = (await getAgenda()).json();
    const plannedTitles = titlesOf(agenda.planned);
    expect(plannedTitles).toContain("Annas Aufgabe heute");
    expect(plannedTitles).toContain("Bens Aufgabe heute");
    expect(plannedTitles).toContain("Gemeinsame Aufgabe heute");
  });

  it("includes the selected member's own explicitly-owned tasks", async () => {
    const anna = await createMember("Anna");
    await createTask({
      title: "Annas eigene Aufgabe",
      ownerMemberId: anna.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: today,
    });

    expect(await bucketsContaining("Annas eigene Aufgabe", anna.id)).toEqual(["planned"]);
  });

  it("includes the selected member's unscheduled actionable tasks", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    await createTask({
      title: "Annas machbare Aufgabe ohne Termin",
      ownerMemberId: anna.id,
      ownerInheritanceMode: "explicit",
    });
    await createTask({
      title: "Bens machbare Aufgabe ohne Termin",
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
    });

    expect(
      await bucketsContaining("Annas machbare Aufgabe ohne Termin", anna.id),
    ).toEqual(["unscheduled"]);
    expect(
      await bucketsContaining("Bens machbare Aufgabe ohne Termin", anna.id),
    ).toEqual([]);
  });

  it("excludes another member's explicitly-owned tasks", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    await createTask({
      title: "Bens Aufgabe",
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: today,
    });

    expect(await bucketsContaining("Bens Aufgabe", anna.id)).toEqual([]);
  });

  it("includes tasks whose owner is inherited from an ancestor/project (effective owner), not just explicit owner", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    const project = await createProject({
      title: "Annas Projekt",
      status: "active",
      ownerMemberId: anna.id,
    });

    // The task has no explicit owner of its own (defaults to "inherit"), so
    // its *effective* owner comes from the project — this must count as
    // Anna's task even though task.ownerMemberId itself is null.
    const inherited = await createTask({
      title: "Von Projekt geerbte Aufgabe",
      projectId: project.id,
      scheduledDate: today,
    });
    expect(inherited.ownerMemberId).toBeNull();
    expect(inherited.effectiveOwnerId).toBe(anna.id);

    expect(await bucketsContaining("Von Projekt geerbte Aufgabe", anna.id)).toEqual(["planned"]);
    expect(await bucketsContaining("Von Projekt geerbte Aufgabe", ben.id)).toEqual([]);
  });

  it("includes tasks with no owner (explicit 'none' / Gemeinsam) for every member", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    const project = await createProject({
      title: "Projekt mit Besitzer",
      status: "active",
      ownerMemberId: anna.id,
    });
    // Explicitly opts out of inheriting the project's owner -> shared/none.
    await createTask({
      title: "Bewusst niemandem zugeordnet",
      projectId: project.id,
      ownerInheritanceMode: "none",
      scheduledDate: today,
    });

    expect(await bucketsContaining("Bewusst niemandem zugeordnet", anna.id)).toEqual(["planned"]);
    expect(await bucketsContaining("Bewusst niemandem zugeordnet", ben.id)).toEqual(["planned"]);
  });

  it("filters the 'revisit' bucket too: a blocked task owned by someone else stays hidden", async () => {
    const anna = await createMember("Anna");
    const ben = await createMember("Ben");
    const blocker = await createTask({ title: "Blockierer (Owner-Filter)" });
    const blocked = await createTask({
      title: "Bens blockierte Wiedervorlage",
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: today,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Bens blockierte Wiedervorlage", ben.id)).toEqual(["revisit"]);
    expect(await bucketsContaining("Bens blockierte Wiedervorlage", anna.id)).toEqual([]);
  });

  it("filters the 'revisit' bucket to include shared/unowned blocked tasks for any member", async () => {
    const anna = await createMember("Anna");
    const blocker = await createTask({ title: "Blockierer (gemeinsam)" });
    const blocked = await createTask({
      title: "Gemeinsame blockierte Wiedervorlage",
      scheduledDate: today,
    });
    await addDependency(blocked.id, blocker.id);

    expect(await bucketsContaining("Gemeinsame blockierte Wiedervorlage", anna.id)).toEqual([
      "revisit",
    ]);
  });

  it("rejects a non-positive-integer memberId with a structured 400", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await getAgenda(bad as unknown as number);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("agenda_query_invalid");
      expect(body.error.details.issues).toBeInstanceOf(Array);
    }
  });

  it("rejects an unknown agenda scope with a structured 400", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/today?scope=other",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("agenda_query_invalid");
  });

  it("rejects an unknown memberId with a structured 404", async () => {
    const res = await getAgenda(999999);
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatchObject({
      code: "member_not_found",
      details: { memberId: 999999 },
    });
  });

  it("uses the caller's calendar date consistently instead of the server timezone", async () => {
    const task = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Lokaler Kalendertag",
        status: "actionable",
        scheduledDate: "2030-01-02",
      },
    });
    expect(task.statusCode).toBe(201);

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/today?date=2030-01-01",
    });
    const onDay = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/today?date=2030-01-02",
    });
    expect(
      before.json().planned.some((entry: { title: string }) => entry.title === "Lokaler Kalendertag"),
    ).toBe(false);
    expect(
      onDay.json().planned.some((entry: { title: string }) => entry.title === "Lokaler Kalendertag"),
    ).toBe(true);
  });

  it("rejects invalid caller calendar dates", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/agenda/today?date=2030-02-30",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("agenda_query_invalid");
  });
});

describe("Heute agenda: compiled project prompts", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  function localTodayIso(): string {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  async function createActiveProject(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload,
    });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    ctx.handle.sqlite
      .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
      .run(project.id);
    return project;
  }

  async function createTask(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { status: "actionable", ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function projectPrompts(memberId?: number) {
    const query = new URLSearchParams({ date: localTodayIso() });
    if (memberId !== undefined) query.set("memberId", String(memberId));
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().projects as Array<{
      project: {
        id: number;
        title: string;
        dueDate: string | null;
        scheduledDate: string | null;
      };
      qualification: "due" | "scheduled" | "both";
      nextAction: { id: number; title: string } | null;
      stuck: { reason: string } | null;
    }>;
  }

  it("starts due prompts at the seven-local-calendar-day boundary and persists overdue", async () => {
    const today = localTodayIso();
    const boundary = await createActiveProject({
      title: "Genau in sieben Tagen",
      dueDate: addDaysIso(today, 7),
    });
    const outside = await createActiveProject({
      title: "Erst in acht Tagen",
      dueDate: addDaysIso(today, 8),
    });
    const overdue = await createActiveProject({
      title: "Seit Langem überfällig",
      dueDate: addDaysIso(today, -30),
    });

    const ids = (await projectPrompts()).map((entry) => entry.project.id);
    expect(ids).toContain(boundary.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(outside.id);
  });

  it("persists reached schedules until rescheduled or completed", async () => {
    const today = localTodayIso();
    const project = await createActiveProject({
      title: "Projekt-Wiedervorlage",
      scheduledDate: addDaysIso(today, -2),
    });

    expect((await projectPrompts()).map((entry) => entry.project.id)).toContain(
      project.id,
    );

    ctx.handle.sqlite
      .prepare("UPDATE projects SET scheduled_date = ? WHERE id = ?")
      .run(addDaysIso(today, 1), project.id);
    expect(
      (await projectPrompts()).map((entry) => entry.project.id),
    ).not.toContain(project.id);

    ctx.handle.sqlite
      .prepare(
        "UPDATE projects SET scheduled_date = ?, status = 'completed' WHERE id = ?",
      )
      .run(today, project.id);
    expect(
      (await projectPrompts()).map((entry) => entry.project.id),
    ).not.toContain(project.id);
  });

  it("deduplicates due and scheduled reasons and applies driver/shared identity semantics", async () => {
    const today = localTodayIso();
    const annaResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Anna Projekt" },
    });
    const benResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Ben Projekt" },
    });
    const anna = annaResponse.json();
    const ben = benResponse.json();
    const both = await createActiveProject({
      title: "Annas fällige Wiedervorlage",
      ownerMemberId: anna.id,
      dueDate: today,
      scheduledDate: today,
    });
    const shared = await createActiveProject({
      title: "Gemeinsames Projekt",
      dueDate: today,
    });
    const other = await createActiveProject({
      title: "Bens Projekt",
      ownerMemberId: ben.id,
      dueDate: today,
    });
    await createActiveProject({
      title: "Backlog trotz Termin",
      dueDate: today,
    }).then((project) => {
      ctx.handle.sqlite
        .prepare("UPDATE projects SET status = 'backlog' WHERE id = ?")
        .run(project.id);
    });

    const prompts = await projectPrompts(anna.id);
    expect(prompts.filter((entry) => entry.project.id === both.id)).toHaveLength(
      1,
    );
    expect(
      prompts.find((entry) => entry.project.id === both.id)?.qualification,
    ).toBe("both");
    expect(prompts.map((entry) => entry.project.id)).toContain(shared.id);
    expect(prompts.map((entry) => entry.project.id)).not.toContain(other.id);
  });

  it("attaches clarified next actions or existing blocked/capture repair context", async () => {
    const today = localTodayIso();
    const ownerResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Projekt-Treiber" },
    });
    const owner = ownerResponse.json();

    const healthy = await createActiveProject({
      title: "Mit nächstem Schritt",
      ownerMemberId: owner.id,
      dueDate: today,
    });
    const next = await createTask({
      projectId: healthy.id,
      title: "Geklärter nächster Schritt",
    });
    await createTask({
      projectId: healthy.id,
      title: "Erfasst davor",
      needsClarification: true,
      position: -1,
    });

    const blocked = await createActiveProject({
      title: "Blockiertes Projekt",
      ownerMemberId: owner.id,
      dueDate: today,
    });
    const blocker = await createTask({
      projectId: blocked.id,
      title: "Offener Blockierer",
      status: "waiting",
    });
    const blockedAction = await createTask({
      projectId: blocked.id,
      title: "Blockierter Schritt",
    });
    const dependency = await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${blockedAction.id}/dependencies`,
      payload: { dependsOnTaskId: blocker.id },
    });
    expect(dependency.statusCode).toBe(201);

    const captured = await createActiveProject({
      title: "Nur erfasstes Projekt",
      ownerMemberId: owner.id,
      scheduledDate: today,
    });
    await createTask({
      projectId: captured.id,
      title: "Noch zu klären",
      needsClarification: true,
    });

    const prompts = await projectPrompts(owner.id);
    expect(
      prompts.find((entry) => entry.project.id === healthy.id)?.nextAction?.id,
    ).toBe(next.id);
    expect(
      prompts.find((entry) => entry.project.id === blocked.id)?.stuck?.reason,
    ).toBe("blocked_dependencies");
    const capturedEntry = prompts.find(
      (entry) => entry.project.id === captured.id,
    );
    expect(capturedEntry?.nextAction).toBeNull();
    expect(capturedEntry?.stuck?.reason).toBe("no_next_action");
    expect(capturedEntry?.stuck).toEqual({ reason: "no_next_action" });
  });
});

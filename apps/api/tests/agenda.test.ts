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
  const afterDueSoonWindow = addDaysIso(today, 4);

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

  async function addExternalWait(
    taskId: number,
    waitingFor = "External event",
    revisitDate?: string,
  ) {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/external-wait`,
      payload: { waitingFor, revisitDate },
    });
    expect(res.statusCode).toBe(200);
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

  it("keeps executable tasks discoverable before their deadline enters due soon", async () => {
    const ownerRes = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Mira" },
    });
    const owner = ownerRes.json();
    await createTask({
      title: "Später fällig, jetzt machbar",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
      dueDate: afterDueSoonWindow,
    });
    await createTask({
      title: "Geteilt und später fällig",
      dueDate: afterDueSoonWindow,
    });

    expect(await bucketsContaining("Später fällig, jetzt machbar")).toEqual([
      "unscheduled",
    ]);
    expect(await bucketsContaining("Geteilt und später fällig")).toEqual([
      "shared",
    ]);
  });

  it("excludes Später-klären captures from Heute", async () => {
    await createTask({
      title: "Noch zu entscheiden",
      needsClarification: true,
    });

    expect(await bucketsContaining("Noch zu entscheiden")).toEqual([]);
  });

  it("excludes standalone someday work even when it has a due date", async () => {
    await createTask({
      title: "Irgendwann fällig",
      status: "someday",
      dueDate: today,
    });
    expect(await bucketsContaining("Irgendwann fällig")).toEqual([]);
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

  it("puts due external follow-ups in revisit and keeps future waits out", async () => {
    const dueWaiting = await createTask({
      title: "Heute nachhaken",
      scheduledDate: tomorrow,
    });
    await addExternalWait(dueWaiting.id, "Offene Rückmeldung", today);
    const futureWaiting = await createTask({
      title: "Später nachhaken",
      scheduledDate: today,
    });
    await addExternalWait(futureWaiting.id, "Spätere Rückmeldung", tomorrow);

    expect(await bucketsContaining("Heute nachhaken")).toEqual(["revisit"]);
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

  it("does not reinterpret a dependency-blocked task's work plan as a revisit", async () => {
    const blocker = await createTask({ title: "Blockierer 4" });
    const blocked = await createTask({
      title: "Blockiert, heute zur Wiedervorlage",
      scheduledDate: today,
    });
    await addDependency(blocked.id, blocker.id);

    expect(
      await bucketsContaining("Blockiert, heute zur Wiedervorlage"),
    ).toEqual([]);
  });

  it("surfaces a direct external wait when its revisit date is in the past", async () => {
    const blocked = await createTask({
      title: "Blockiert, längst überfällig geplant",
      scheduledDate: tomorrow,
    });
    await addExternalWait(blocked.id, "Rückmeldung", yesterday);

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

  it("moves a waiting task into its planned bucket once the wait ends", async () => {
    const blocked = await createTask({
      title: "Wird später entblockt",
      scheduledDate: today,
    });
    const waiting = await addExternalWait(blocked.id, "Antwort", today);

    expect(await bucketsContaining("Wird später entblockt")).toEqual(["revisit"]);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/tasks/${blocked.id}/external-wait`,
      payload: { expectedRevision: waiting.revision },
    });

    expect(await bucketsContaining("Wird später entblockt")).toEqual(["planned"]);
  });

  it("keeps every bucket, including revisit, mutually exclusive with no duplicate tasks", async () => {
    const revisitTask = await createTask({
      title: "Revisit-Kandidat",
      scheduledDate: today,
      dueDate: today,
    });
    await addExternalWait(revisitTask.id, "Antwort", today);

    await createTask({ title: "Ganz normal geplant", scheduledDate: today });
    await createTask({ title: "Überfällig", dueDate: yesterday });
    await createTask({ title: "Heute fällig", dueDate: today });
    await createTask({ title: "Bald fällig", dueDate: addDaysIso(today, 2) });
    await createTask({ title: "Gemeinsam offen" });

    const agenda = await getAgenda();
    const allIds = bucketKeys.flatMap((key) => agenda[key]).map((t: { id: number }) => t.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    // The externally waiting, planned, and due task lands only in revisit.
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

  it("orders each task section by its public date and priority contract", async () => {
    const ownerResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/members",
      payload: { name: "Sortiererin" },
    });
    const owner = ownerResponse.json();

    await createTask({
      title: "Planned today high",
      scheduledDate: today,
      priority: 1,
    });
    await createTask({
      title: "Planned yesterday low",
      scheduledDate: yesterday,
      priority: 5,
    });

    const revisitToday = await createTask({
      title: "Revisit today high",
      scheduledDate: today,
      priority: 1,
    });
    await addExternalWait(revisitToday.id, "External event", today);
    const revisitYesterday = await createTask({
      title: "Revisit yesterday low",
      scheduledDate: yesterday,
      priority: 5,
    });
    await addExternalWait(revisitYesterday.id, "External event", yesterday);

    await createTask({
      title: "Overdue recent high",
      dueDate: yesterday,
      priority: 1,
    });
    await createTask({
      title: "Overdue oldest low",
      dueDate: addDaysIso(today, -2),
      priority: 5,
    });
    await createTask({
      title: "Soon later high",
      dueDate: addDaysIso(today, 2),
      priority: 1,
    });
    await createTask({
      title: "Soon earliest low",
      dueDate: tomorrow,
      priority: 5,
    });
    await createTask({
      title: "Today due low",
      dueDate: today,
      priority: 5,
    });
    await createTask({
      title: "Today due high",
      dueDate: today,
      priority: 1,
    });

    await createTask({ title: "Shared low", priority: 5 });
    await createTask({ title: "Shared Zulu", priority: 3 });
    const sharedAlphaFirst = await createTask({
      title: "Shared Alpha",
      priority: 3,
    });
    const sharedAlphaSecond = await createTask({
      title: "Shared Alpha",
      priority: 3,
    });
    await createTask({ title: "Shared none" });
    await createTask({
      title: "Owned low",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
      priority: 5,
    });
    await createTask({
      title: "Owned high",
      ownerMemberId: owner.id,
      ownerInheritanceMode: "explicit",
      priority: 1,
    });

    const agenda = await getAgenda();
    const ids = (section: Array<{ id: number; title: string }>, prefix: string) =>
      section.filter((task) => task.title.startsWith(prefix)).map((task) => task.id);
    const titles = (
      section: Array<{ title: string }>,
      prefix: string,
    ) => section.filter((task) => task.title.startsWith(prefix)).map((task) => task.title);

    expect(titles(agenda.planned, "Planned")).toEqual([
      "Planned yesterday low",
      "Planned today high",
    ]);
    expect(titles(agenda.revisit, "Revisit")).toEqual([
      "Revisit yesterday low",
      "Revisit today high",
    ]);
    expect(titles(agenda.overdue, "Overdue")).toEqual([
      "Overdue oldest low",
      "Overdue recent high",
    ]);
    expect(titles(agenda.dueSoon, "Soon")).toEqual([
      "Soon earliest low",
      "Soon later high",
    ]);
    expect(titles(agenda.dueToday, "Today due")).toEqual([
      "Today due high",
      "Today due low",
    ]);
    expect(titles(agenda.shared, "Shared")).toEqual([
      "Shared Alpha",
      "Shared Alpha",
      "Shared Zulu",
      "Shared low",
      "Shared none",
    ]);
    expect(ids(agenda.shared, "Shared Alpha")).toEqual([
      sharedAlphaFirst.id,
      sharedAlphaSecond.id,
    ]);
    expect(titles(agenda.unscheduled, "Owned")).toEqual([
      "Owned high",
      "Owned low",
    ]);
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
    const requestedActive = payload.status === "active";
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: requestedActive ? { ...payload, status: "backlog" } : payload,
    });
    const project = res.json();
    if (requestedActive) {
      ctx.handle.sqlite
        .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
        .run(project.id);
    }
    return project;
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

  async function addExternalWait(taskId: number, revisitDate: string) {
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/external-wait`,
      payload: { waitingFor: "Antwort", revisitDate },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
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

  it("does not use sibling positions to order tasks from unrelated projects", async () => {
    const anna = await createMember("Anna");
    const alphaProject = await createProject({
      title: "Alpha-Projekt",
      status: "active",
      ownerMemberId: anna.id,
    });
    const zuluProject = await createProject({
      title: "Zulu-Projekt",
      status: "active",
      ownerMemberId: anna.id,
    });
    const alpha = await createTask({
      title: "Alpha aus anderem Projekt",
      projectId: alphaProject.id,
      priority: 3,
    });
    const zulu = await createTask({
      title: "Zulu aus anderem Projekt",
      projectId: zuluProject.id,
      priority: 3,
    });
    ctx.handle.sqlite
      .prepare("UPDATE tasks SET position = CASE id WHEN ? THEN 99 ELSE 0 END WHERE id IN (?, ?)")
      .run(alpha.id, alpha.id, zulu.id);

    const agenda = (await getAgenda(anna.id)).json();
    expect(
      agenda.unscheduled
        .filter((task: { id: number }) => task.id === alpha.id || task.id === zulu.id)
        .map((task: { id: number }) => task.id),
    ).toEqual([alpha.id, zulu.id]);
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
    const blocked = await createTask({
      title: "Bens blockierte Wiedervorlage",
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
      scheduledDate: today,
    });
    await addExternalWait(blocked.id, today);

    expect(await bucketsContaining("Bens blockierte Wiedervorlage", ben.id)).toEqual(["revisit"]);
    expect(await bucketsContaining("Bens blockierte Wiedervorlage", anna.id)).toEqual([]);
  });

  it("filters the 'revisit' bucket to include shared/unowned blocked tasks for any member", async () => {
    const anna = await createMember("Anna");
    const blocked = await createTask({
      title: "Gemeinsame blockierte Wiedervorlage",
      scheduledDate: today,
    });
    await addExternalWait(blocked.id, today);

    expect(await bucketsContaining("Gemeinsame blockierte Wiedervorlage", anna.id)).toEqual([
      "revisit",
    ]);
  });

  it("advances ordinary project work through canonical next-action order", async () => {
    const anna = await createMember("Anna sequence");
    const project = await createProject({
      title: "Sequenced project",
      status: "active",
      ownerMemberId: anna.id,
    });
    const first = await createTask({
      title: "First canonical",
      projectId: project.id,
    });
    await createTask({
      title: "Second canonical",
      projectId: project.id,
    });

    expect(await bucketsContaining("First canonical", anna.id)).toEqual([
      "unscheduled",
    ]);
    expect(await bucketsContaining("Second canonical", anna.id)).toEqual([]);
    await ctx.app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/complete`,
      payload: {},
    });
    expect(await bucketsContaining("Second canonical", anna.id)).toEqual([
      "unscheduled",
    ]);
  });

  it("selects the first canonical project candidate in the member or shared lane", async () => {
    const anna = await createMember("Anna lanes");
    const ben = await createMember("Ben lanes");
    const project = await createProject({
      title: "Owned lanes",
      status: "active",
      ownerMemberId: anna.id,
    });
    await createTask({
      title: "Ben first",
      projectId: project.id,
      ownerMemberId: ben.id,
      ownerInheritanceMode: "explicit",
    });
    await createTask({
      title: "Anna second",
      projectId: project.id,
      ownerMemberId: anna.id,
      ownerInheritanceMode: "explicit",
    });
    await createTask({
      title: "Shared third",
      projectId: project.id,
      ownerInheritanceMode: "none",
    });

    expect(await bucketsContaining("Ben first", anna.id)).toEqual([]);
    expect(await bucketsContaining("Anna second", anna.id)).toEqual([
      "unscheduled",
    ]);
    expect(await bucketsContaining("Shared third", anna.id)).toEqual([]);
  });

  it("in all scope keeps one canonical candidate per effective-owner/shared lane", async () => {
    const anna = await createMember("Anna all");
    const ben = await createMember("Ben all");
    const project = await createProject({
      title: "Parallel lanes",
      status: "active",
      ownerMemberId: anna.id,
    });
    for (const [title, ownerMemberId, ownerInheritanceMode] of [
      ["Anna 1", anna.id, "explicit"],
      ["Anna 2", anna.id, "explicit"],
      ["Ben 1", ben.id, "explicit"],
      ["Shared 1", null, "none"],
      ["Shared 2", null, "none"],
    ] as const) {
      await createTask({
        title,
        projectId: project.id,
        ownerMemberId,
        ownerInheritanceMode,
      });
    }

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?scope=all&date=${today}`,
    });
    const agenda = response.json();
    const ordinaryTitles = [...agenda.shared, ...agenda.unscheduled].map(
      (task: { title: string }) => task.title,
    );
    expect(ordinaryTitles).toEqual(
      expect.arrayContaining(["Anna 1", "Ben 1", "Shared 1"]),
    );
    expect(ordinaryTitles).not.toEqual(
      expect.arrayContaining(["Anna 2", "Shared 2"]),
    );
  });

  it("keeps explicit date signals independent of structural selection with no duplicates or review-age effect", async () => {
    const anna = await createMember("Anna dates");
    const project = await createProject({
      title: "Dated project tasks",
      status: "active",
      ownerMemberId: anna.id,
    });
    await createTask({ title: "Ordinary selected", projectId: project.id });
    const dated = await createTask({
      title: "Later but due",
      projectId: project.id,
      dueDate: today,
    });
    ctx.handle.sqlite
      .prepare(
        "UPDATE projects SET reviewed_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(project.id);
    ctx.handle.sqlite
      .prepare(
        "UPDATE tasks SET reviewed_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(dated.id);

    expect(await bucketsContaining("Later but due", anna.id)).toEqual([
      "dueToday",
    ]);
    const agenda = (await getAgenda(anna.id)).json();
    const ids = bucketKeys.flatMap((key) =>
      agenda[key].map((task: { id: number }) => task.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
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
      needsClarification: true,
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
    ).toBe("blocked_without_clear_path");
    const capturedEntry = prompts.find(
      (entry) => entry.project.id === captured.id,
    );
    expect(capturedEntry?.nextAction).toBeNull();
    expect(capturedEntry?.stuck?.reason).toBe("no_next_action");
    expect(capturedEntry?.stuck).toEqual({ reason: "no_next_action" });
  });
});

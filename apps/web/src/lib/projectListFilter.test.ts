import { describe, expect, it } from "vitest";
import { classifyProjectListItem, filterAndSortProjects } from "./projectListFilter";
import { makeCriterion, makeProject, makeTask } from "../test/fixtures";

describe("classifyProjectListItem", () => {
  it("classifies all project-list states", () => {
    expect(
      classifyProjectListItem(
        makeProject({
          status: "active",
          nextAction: makeTask(),
          stuckReason: null,
        }),
      ),
    ).toBe("active-actionable");
    expect(
      classifyProjectListItem(
        makeProject({
          status: "active",
          nextAction: null,
          stuckReason: null,
        }),
      ),
    ).toBe("active-waiting");
    expect(
      classifyProjectListItem(
        makeProject({
          status: "active",
          nextAction: null,
          deferredNextAction: makeTask(),
          stuckReason: null,
        }),
      ),
    ).toBe("active-deferred");
    expect(classifyProjectListItem(makeProject({ status: "backlog" }))).toBe("backlog");
    expect(classifyProjectListItem(makeProject({ status: "completed" }))).toBe("completed");
    expect(classifyProjectListItem(makeProject({ status: "archived" }))).toBe("archived");
  });

  it.each([
    ["blocked active project", "blocked_without_clear_path", makeTask()],
    ["active project with no task", "no_next_action", null],
  ] as const)("classifies a %s as stuck rather than waiting", (_label, stuckReason, nextAction) => {
    const project = makeProject({
      status: "active",
      nextAction,
      stuckReason,
    });

    expect(classifyProjectListItem(project)).toBe("active-stuck");
  });

  it("classifies an active project awaiting completion review as ready-to-complete, not stuck", () => {
    const project = makeProject({
      status: "active",
      nextAction: null,
      stuckReason: "completion_review",
    });

    expect(classifyProjectListItem(project)).toBe("active-review");
  });

  it("only classifies an active project with no next action and no stuck reason as active waiting", () => {
    const waiting = makeProject({ status: "active", nextAction: null, stuckReason: null });
    const actionable = makeProject({ status: "active", nextAction: makeTask(), stuckReason: null });
    const backlogWithoutAction = makeProject({ status: "backlog", nextAction: null, stuckReason: null });

    expect(classifyProjectListItem(waiting)).toBe("active-waiting");
    expect(classifyProjectListItem(actionable)).toBe("active-actionable");
    expect(classifyProjectListItem(backlogWithoutAction)).toBe("backlog");
  });

  it("keeps a reached structural revisit actionable for an active project", () => {
    const project = makeProject({
      status: "active",
      nextAction: makeTask({ executable: false, revisitAt: "2020-01-01T12:00:00.000Z" }),
      stuckReason: null,
    });
    expect(classifyProjectListItem(project)).toBe("active-actionable");
  });

  it("keeps an active project under a parked ancestor out of actionable projects", () => {
    const project = makeProject({
      status: "active", effectivelyParked: true, nextAction: makeTask(), stuckReason: null,
    });
    expect(classifyProjectListItem(project)).toBe("active-deferred");
  });

  it("does not claim actionability when inherited parking is not visible", () => {
    const project = makeProject({
      status: "active", effectivelyParked: null, nextAction: makeTask(), stuckReason: null,
    });
    expect(classifyProjectListItem(project)).toBe("active-deferred");
  });
});

describe("filterAndSortProjects", () => {
  it("sorts every classification into its deterministic bucket order", () => {
    const archived = makeProject({ id: 1, title: "Archiviert", status: "archived", position: 0 });
    const completed = makeProject({ id: 2, title: "Fertig", status: "completed", position: 0 });
    const backlog = makeProject({ id: 3, title: "Rückstand", status: "backlog", position: 0 });
    const healthyWaiting = makeProject({
      id: 4,
      title: "Wartet gesund",
      status: "active",
      position: 0,
      nextAction: null,
      stuckReason: null,
    });
    const activeStuck = makeProject({
      id: 5,
      title: "Festgefahren",
      status: "active",
      position: 0,
      nextAction: null,
      stuckReason: "no_next_action",
    });
    const activeActionable = makeProject({
      id: 6,
      title: "Läuft",
      status: "active",
      position: 0,
      nextAction: makeTask(),
      stuckReason: null,
    });

    // Shuffled input — the sort must not depend on input order.
    const result = filterAndSortProjects(
      [healthyWaiting, archived, activeStuck, completed, activeActionable, backlog],
      {
        query: "",
        scope: "all",
        currentMemberId: null,
      },
    );

    expect(result.map((p) => p.id)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("sorts active-review (ready-to-complete) between actionable and stuck active work", () => {
    const activeStuck = makeProject({
      id: 1,
      title: "Festgefahren",
      status: "active",
      position: 0,
      nextAction: null,
      stuckReason: "no_next_action",
    });
    const activeReview = makeProject({
      id: 2,
      title: "Bereit zum Abschließen",
      status: "active",
      position: 0,
      nextAction: null,
      stuckReason: "completion_review",
    });
    const activeActionable = makeProject({
      id: 3,
      title: "Läuft",
      status: "active",
      position: 0,
      nextAction: makeTask(),
      stuckReason: null,
    });

    const result = filterAndSortProjects([activeStuck, activeActionable, activeReview], {
      query: "",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([3, 2, 1]);
  });

  it("orders actionable projects by earliest deadline, then next-action priority", () => {
    const overdue = makeProject({
      id: 15,
      title: "Frist vorbei",
      status: "active",
      position: 99,
      dueDate: "2026-08-30",
      nextAction: makeTask({ priority: 5 }),
    });
    const nextActionDeadline = makeProject({
      id: 16,
      title: "Nächste Aktion fällig",
      status: "active",
      position: 0,
      dueDate: "2026-10-01",
      nextAction: makeTask({ dueDate: "2026-09-02", priority: 5 }),
    });
    const projectDeadline = makeProject({
      id: 17,
      title: "Projektfrist fällig",
      status: "active",
      position: 99,
      dueDate: "2026-09-02",
      nextAction: makeTask({ priority: 1 }),
    });
    const highPriorityNoDeadline = makeProject({
      id: 18,
      title: "Hohe Priorität ohne Frist",
      status: "active",
      position: 99,
      nextAction: makeTask({ priority: 1 }),
    });
    const lowerPriorityNoDeadline = makeProject({
      id: 19,
      title: "Niedrigere Priorität ohne Frist",
      status: "active",
      position: 0,
      nextAction: makeTask({ priority: 4 }),
    });

    const result = filterAndSortProjects(
      [lowerPriorityNoDeadline, nextActionDeadline, overdue, highPriorityNoDeadline, projectDeadline],
      { query: "", scope: "all", currentMemberId: null, now: new Date(2026, 7, 31) },
    );

    expect(result.map((project) => project.id)).toEqual([15, 17, 16, 18, 19]);
  });

  it("classifies future-scheduled next actions as quiet", () => {
    const now = new Date(2026, 7, 31, 23, 30);
    const actionable = makeProject({
      id: 1,
      title: "Jetzt",
      status: "active",
      nextAction: makeTask({ scheduledDate: null }),
    });
    const stuck = makeProject({
      id: 2,
      title: "Blockiert",
      status: "active",
      nextAction: null,
      stuckReason: "no_next_action",
    });
    const deferred = makeProject({
      id: 3,
      title: "Später",
      status: "active",
      nextAction: makeTask({ scheduledDate: "2026-09-10" }),
    });
    const waiting = makeProject({
      id: 4,
      title: "Wartet extern",
      status: "active",
      nextAction: null,
      stuckReason: null,
    });

    const result = filterAndSortProjects(
      [waiting, deferred, stuck, actionable],
      {
        query: "",
        scope: "all",
        currentMemberId: null,
        now,
      },
    );

    expect(result.map((project) => project.id)).toEqual([1, 2, 3, 4]);
    expect(classifyProjectListItem(deferred, now)).toBe("active-deferred");
  });

  it("interleaves quiet projects by next-action date and external-wait revisit date", () => {
    const now = new Date(2026, 7, 31, 23, 30);
    const undatedNextAction = makeProject({
      id: 5,
      title: "Nächster Schritt ohne Datum",
      status: "active",
      position: 99,
      nextAction: null,
      deferredNextAction: makeTask({ scheduledDate: null, revisitAt: null }),
    });
    const scheduledLater = makeProject({
      id: 1,
      title: "Aktion später",
      status: "active",
      position: 0,
      nextAction: makeTask({ scheduledDate: "2026-09-12" }),
    });
    const waitSooner = makeProject({
      id: 2,
      title: "Wiedervorlage früher",
      status: "active",
      position: 99,
      nextAction: null,
      stuckReason: null,
      waitingUntil: "2026-09-03T08:00:00.000Z",
    });
    const scheduledSooner = makeProject({
      id: 3,
      title: "Aktion früher",
      status: "active",
      position: 99,
      nextAction: makeTask({ scheduledDate: "2026-09-06" }),
    });
    const waitWithoutDate = makeProject({
      id: 4,
      title: "Wiedervorlage offen",
      status: "active",
      position: 0,
      nextAction: null,
      stuckReason: null,
      waitingUntil: null,
    });
    const deferredWithDate = makeProject({
      id: 6,
      title: "Verfügbar ab früher",
      status: "active",
      position: 99,
      nextAction: null,
      deferredNextAction: makeTask({
        scheduledDate: null,
        revisitAt: "2026-09-02T08:00:00.000Z",
      }),
    });

    const result = filterAndSortProjects(
      [scheduledLater, waitWithoutDate, scheduledSooner, waitSooner, undatedNextAction, deferredWithDate],
      { query: "", scope: "all", currentMemberId: null, now },
    );

    expect(result.map((project) => project.id)).toEqual([5, 6, 2, 3, 1, 4]);
  });

  it("breaks ties within a bucket by position, then locale title, then id", () => {
    const a = makeProject({ id: 30, title: "Zebra", status: "backlog", position: 1 });
    const b = makeProject({ id: 20, title: "Apfel", status: "backlog", position: 1 });
    const c = makeProject({ id: 10, title: "Apfel", status: "backlog", position: 1 });
    const d = makeProject({ id: 40, title: "Möhre", status: "backlog", position: 0 });

    const result = filterAndSortProjects([a, b, c, d], { query: "", scope: "all", currentMemberId: null });

    // position 0 sorts before position 1 regardless of title/id.
    expect(result[0]?.id).toBe(40);
    // Within position 1: "Apfel" < "Apfel" (tie) resolved by id, then "Zebra".
    expect(result.slice(1).map((p) => p.id)).toEqual([10, 20, 30]);
  });

  it("matches the search text against the title, case-insensitively and diacritic-tolerantly", () => {
    const target = makeProject({ id: 1, title: "Überarbeitung Küche" });
    const other = makeProject({ id: 2, title: "Garten" });

    const result = filterAndSortProjects([target, other], {
      query: "uberarbeitung",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([1]);
  });

  it("matches the search text against acceptance-criterion text, not just the title", () => {
    const withCriterion = makeProject({
      id: 1,
      title: "Küche",
      acceptanceCriteria: [makeCriterion({ id: 1, projectId: 1, text: "Fliesen sind café-farben lackiert" })],
    });

    const withoutMatch = makeProject({ id: 2, title: "Garten" });

    const result = filterAndSortProjects([withCriterion, withoutMatch], {
      query: "cafe",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([1]);
  });

  it("matches free-form project notes independently from completion criteria", () => {
    const withNotes = makeProject({
      id: 1,
      title: "Waschmaschine",
      notes: "Kellerzugang ist sehr eng",
    });
    const other = makeProject({ id: 2, title: "Garten" });

    const result = filterAndSortProjects([withNotes, other], {
      query: "kellerzugang",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((project) => project.id)).toEqual([1]);
  });

  it("matches computed waiting reasons", () => {
    const waiting = makeProject({
      id: 1,
      title: "Küche",
      waitingOn: ["Angebot der Schreinerei"],
    });
    const other = makeProject({ id: 2, title: "Garten" });

    const result = filterAndSortProjects([waiting, other], {
      query: "schreinerei",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((project) => project.id)).toEqual([1]);
  });

  it("with a selected identity, default (mine) scope shows that member's stories plus unassigned ones", () => {
    const mine = makeProject({ id: 1, title: "Meins", ownerMemberId: 7 });
    const unassigned = makeProject({ id: 2, title: "Niemand", ownerMemberId: null });
    const someoneElse = makeProject({ id: 3, title: "Fremd", ownerMemberId: 9 });

    const result = filterAndSortProjects([mine, unassigned, someoneElse], {
      query: "",
      scope: "mine",
      currentMemberId: 7,
    });

    expect(result.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it("with no identity selected, default (mine) scope sensibly shows only unassigned stories", () => {
    const owned = makeProject({ id: 1, title: "Fremd", ownerMemberId: 9 });
    const unassigned = makeProject({ id: 2, title: "Niemand", ownerMemberId: null });

    const result = filterAndSortProjects([owned, unassigned], {
      query: "",
      scope: "mine",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([2]);
  });

  it("the all scope shows every story regardless of owner", () => {
    const mine = makeProject({ id: 1, ownerMemberId: 7 });
    const someoneElse = makeProject({ id: 2, ownerMemberId: 9 });
    const unassigned = makeProject({ id: 3, ownerMemberId: null });

    const result = filterAndSortProjects([mine, someoneElse, unassigned], {
      query: "",
      scope: "all",
      currentMemberId: 7,
    });

    expect(result.map((p) => p.id).sort()).toEqual([1, 2, 3]);
  });

  it("filters before sorting, so an excluded story never occupies a bucket slot", () => {
    const matching = makeProject({ id: 1, title: "Küche renovieren", status: "backlog" });
    const nonMatching = makeProject({ id: 2, title: "Garten", status: "active" });

    const result = filterAndSortProjects([matching, nonMatching], {
      query: "küche",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([1]);
  });

});

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
    ).toBe("healthy-waiting");
    expect(classifyProjectListItem(makeProject({ status: "backlog" }))).toBe("backlog");
    expect(classifyProjectListItem(makeProject({ status: "completed" }))).toBe("completed");
    expect(classifyProjectListItem(makeProject({ status: "archived" }))).toBe("archived");
  });

  it.each([
    ["blocked active project", "blocked_without_clear_path", makeTask()],
    ["active project with no task", "no_next_action", null],
    ["active project awaiting completion review", "completion_review", null],
  ] as const)("classifies a %s as stuck rather than waiting", (_label, stuckReason, nextAction) => {
    const project = makeProject({
      status: "active",
      nextAction,
      stuckReason,
    });

    expect(classifyProjectListItem(project)).toBe("active-stuck");
  });

  it("only classifies an active project with no next action and no stuck reason as healthy waiting", () => {
    const waiting = makeProject({ status: "active", nextAction: null, stuckReason: null });
    const actionable = makeProject({ status: "active", nextAction: makeTask(), stuckReason: null });
    const backlogWithoutAction = makeProject({ status: "backlog", nextAction: null, stuckReason: null });

    expect(classifyProjectListItem(waiting)).toBe("healthy-waiting");
    expect(classifyProjectListItem(actionable)).toBe("active-actionable");
    expect(classifyProjectListItem(backlogWithoutAction)).toBe("backlog");
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

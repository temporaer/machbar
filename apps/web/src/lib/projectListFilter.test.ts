import { describe, expect, it } from "vitest";
import { filterAndSortProjects } from "./projectListFilter";
import { makeCriterion, makeProject } from "../test/fixtures";

describe("filterAndSortProjects", () => {
  it("sorts every status into its bucket: active healthy, active stuck, backlog, completed, archived", () => {
    const archived = makeProject({ id: 1, title: "Archiviert", status: "archived", position: 0 });
    const completed = makeProject({ id: 2, title: "Fertig", status: "completed", position: 0 });
    const backlog = makeProject({ id: 3, title: "Rückstand", status: "backlog", position: 0 });
    const activeStuck = makeProject({
      id: 4,
      title: "Festgefahren",
      status: "active",
      position: 0,
      stuckReason: "no_next_action",
    });
    const activeHealthy = makeProject({ id: 5, title: "Läuft", status: "active", position: 0 });

    // Shuffled input — the sort must not depend on input order.
    const result = filterAndSortProjects([archived, completed, backlog, activeStuck, activeHealthy], {
      query: "",
      scope: "all",
      currentMemberId: null,
    });

    expect(result.map((p) => p.id)).toEqual([5, 4, 3, 2, 1]);
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

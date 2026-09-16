import type { SearchFilters } from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("de-DE")
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized === "" ? [] : normalized.split(" ");
}

function comparableSearchTokens(value: string): Set<string> {
  return new Set(
    searchTokens(value).map((token) =>
      token.replace(/^(\p{L}{3,})zu(\p{L}{2,})$/u, "$1$2"),
    ),
  );
}

function everyTokenIn(tokens: Set<string>, container: Set<string>): boolean {
  return [...tokens].every((token) => container.has(token));
}

function scoreTitle(query: string, queryTokens: Set<string>, title: string): number {
  const titleTokens = comparableSearchTokens(title);
  const normalizedTitle = normalizeSearchText(title);
  const overlap = [...queryTokens].filter((token) => titleTokens.has(token)).length;
  const queryCoverage = overlap / queryTokens.size;

  if (normalizedTitle === query) return 1000;
  if (normalizedTitle !== "" && normalizedTitle.includes(query)) return 950;
  if (normalizedTitle !== "" && query.includes(normalizedTitle)) return 925;
  if (titleTokens.size >= 2 && everyTokenIn(titleTokens, queryTokens)) return 900;
  if (everyTokenIn(queryTokens, titleTokens)) return 875;
  if (overlap >= 2 && queryCoverage >= 0.5) {
    return Math.min(874, 800 + Math.round(100 * queryCoverage));
  }
  if (queryTokens.size === 1 && titleTokens.has(query)) return 700;
  return 0;
}

function scoreNotes(query: string, queryTokens: Set<string>, notes: string): number {
  const normalizedNotes = normalizeSearchText(notes);
  const notesTokens = comparableSearchTokens(notes);
  const overlap = [...queryTokens].filter((token) => notesTokens.has(token)).length;
  const queryCoverage = overlap / queryTokens.size;

  if (normalizedNotes.includes(query)) return 400;
  if (everyTokenIn(queryTokens, notesTokens)) return 350;
  if (overlap >= 2 && queryCoverage >= 0.5) {
    return Math.min(349, 300 + Math.round(40 * queryCoverage));
  }
  if (queryTokens.size === 1 && notesTokens.has(query)) return 250;
  return 0;
}

export function searchTasks(graph: Graph, filters: SearchFilters): TaskRecord[] {
  let results = graph.allTasks();

  // Default interactive search focuses on live work: terminal tasks (done,
  // cancelled) are excluded unless the caller explicitly asked for one via
  // `filters.status`, or opted the whole view into exhaustive inventory via
  // `filters.includeTerminal` (e.g. the All page) — either way terminal
  // tasks stay fully reachable, just not by default in focused pickers.
  if (filters.status === undefined && !filters.includeTerminal) {
    results = results.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    );
  }

  const textQuery = filters.text;
  const hasTextQuery = textQuery !== undefined && textQuery.trim() !== "";
  const textScores = new Map<number, { max: number; title: number }>();
  if (hasTextQuery) {
    const query = normalizeSearchText(textQuery);
    const queryTokens = comparableSearchTokens(textQuery);
    if (query === "") return [];
    results = results.filter((task) => {
      const title = scoreTitle(query, queryTokens, task.title);
      const notes = scoreNotes(query, queryTokens, task.notes);
      const max = Math.max(title, notes);
      if (max === 0) return false;
      textScores.set(task.id, { max, title });
      return true;
    });
  }
  if (filters.ownerId !== undefined) {
    results = results.filter((t) => t.effectiveOwnerId === filters.ownerId);
  }
  if (filters.projectId !== undefined) {
    results = results.filter((t) => t.projectId === filters.projectId);
  }
  if (filters.tagIds && filters.tagIds.length > 0) {
    const wanted = filters.tagIds;
    results = results.filter((t) => {
      const owned = new Set(t.effectiveTags.map((tag) => tag.id));
      return wanted.every((id) => owned.has(id));
    });
  }
  if (filters.status !== undefined) {
    results = results.filter((t) => t.status === filters.status);
  }
  if (filters.dueFrom !== undefined) {
    results = results.filter((t) => !!t.dueDate && t.dueDate >= filters.dueFrom!);
  }
  if (filters.dueTo !== undefined) {
    results = results.filter((t) => !!t.dueDate && t.dueDate <= filters.dueTo!);
  }
  if (filters.scheduledFrom !== undefined) {
    results = results.filter(
      (t) => !!t.scheduledDate && t.scheduledDate >= filters.scheduledFrom!,
    );
  }
  if (filters.scheduledTo !== undefined) {
    results = results.filter(
      (t) => !!t.scheduledDate && t.scheduledDate <= filters.scheduledTo!,
    );
  }
  if (filters.blocked !== undefined) {
    results = results.filter((task) => task.blocked === filters.blocked);
  }
  if (filters.externalWait !== undefined) {
    results = results.filter(
      (task) => (task.externalWait !== null) === filters.externalWait,
    );
  }

  return results.sort((a, b) => {
    if (hasTextQuery) {
      const aScore = textScores.get(a.id)!;
      const bScore = textScores.get(b.id)!;
      return (
        bScore.max - aScore.max ||
        bScore.title - aScore.title ||
        a.id - b.id
      );
    }
    return a.id - b.id;
  });
}

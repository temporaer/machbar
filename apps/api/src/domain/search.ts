import type { SearchFilters } from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";

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

  if (filters.text && filters.text.trim() !== "") {
    const needle = filters.text.trim().toLowerCase();
    results = results.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.notes.toLowerCase().includes(needle),
    );
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

  return results.sort((a, b) => a.id - b.id);
}

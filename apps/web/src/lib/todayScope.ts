import type { AgendaScope } from "./api";

const STORAGE_KEY = "machbar:today-scope";

export function readTodayScope(): AgendaScope {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value === "all" || value === "work" ? value : "mine";
  } catch {
    return "mine";
  }
}

export function writeTodayScope(scope: AgendaScope): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, scope);
  } catch {
    // The in-memory selection still works when session storage is unavailable.
  }
}

/** Mine -> Household -> Work -> Mine, the cycle order for the shared
 * scope-toggle button used on Today/Week/Projects/Waiting. */
export function nextAgendaScope(scope: AgendaScope): AgendaScope {
  return scope === "mine" ? "all" : scope === "all" ? "work" : "mine";
}

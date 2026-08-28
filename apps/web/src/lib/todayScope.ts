import type { AgendaScope } from "./api";

const STORAGE_KEY = "machbar:today-scope";

export function readTodayScope(): AgendaScope {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "all"
      ? "all"
      : "mine";
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

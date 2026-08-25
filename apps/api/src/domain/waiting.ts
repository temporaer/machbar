import type { WaitingGroup } from "@machbar/shared";
import type { Graph, TaskRecord } from "./graph.js";

const UNKNOWN_GROUP = "Unbekannt";

/** Groups all "waiting" tasks by their `waitingFor` text (Wartet view). */
export function buildWaitingGroups(graph: Graph): WaitingGroup[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of graph.allTasks()) {
    if (task.status !== "waiting") continue;
    const key = task.waitingFor?.trim() || UNKNOWN_GROUP;
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "de"))
    .map(([waitingFor, tasks]) => ({
      waitingFor,
      tasks: tasks.sort((a, b) => {
        const dueA = a.dueDate ?? "9999-99-99";
        const dueB = b.dueDate ?? "9999-99-99";
        if (dueA !== dueB) return dueA < dueB ? -1 : 1;
        return a.position - b.position;
      }),
    }));
}

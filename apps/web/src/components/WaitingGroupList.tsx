import { useState } from "react";
import type { Task, WaitingGroup } from "@machbar/shared";
import { strings } from "../lib/strings";
import { TaskOutline } from "./TaskOutline";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";

/**
 * Flattens the backend's `WaitingGroup[]` (tasks bucketed by `waitingFor`)
 * into a single ordered `Task[]` for `TaskOutline`, preserving group order
 * and each group's task order exactly — no regrouping, no external group
 * headings, and no duplicates, since every task appears in exactly one
 * backend group.
 *
 * Each task's `waitingFor` is displayed via `TaskRow`'s existing meta line;
 * when a task's own `waitingFor` is null/blank, `group.waitingFor` (e.g.
 * "Unbekannt") is used as a display-only fallback. This never touches the
 * API — it's purely a shallow copy for rendering.
 *
 * `position` is also rewritten to a sequential index matching this flat
 * order, since `TaskOutline` sorts its root tasks by `position` even when
 * `organizable` is false; the tasks here come from unrelated sibling groups
 * whose real `position` values aren't comparable across groups.
 */
function toDisplayTasks(groups: WaitingGroup[]): Task[] {
  const tasks: Task[] = [];
  let position = 0;
  for (const group of groups) {
    for (const task of group.tasks) {
      const waitingFor = task.waitingFor?.trim() ? task.waitingFor : group.waitingFor;
      tasks.push({ ...task, waitingFor, position: position++ });
    }
  }
  return tasks;
}

export function WaitingGroupList({ groups }: { groups: WaitingGroup[] }) {
  const [followUpTask, setFollowUpTask] = useState<Task | null>(null);

  return (
    <>
      <TaskOutline
        tasks={toDisplayTasks(groups)}
        emptyMessage={strings.waitingEmpty}
        organizable={false}
        waitingInteraction={{ onFollowUp: setFollowUpTask }}
      />
      {followUpTask ? (
        <WaitingFollowUpSheet task={followUpTask} onClose={() => setFollowUpTask(null)} />
      ) : null}
    </>
  );
}

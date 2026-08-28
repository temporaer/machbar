import { useState } from "react";
import type { Task, WaitingGroup } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { TaskOutline } from "./TaskOutline";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import {
  groupItemsByTagKind,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { useLocale } from "../lib/locale";

/**
 * Flattens the backend's `WaitingGroup[]` (tasks bucketed by `waitingFor`)
 * into a single ordered `Task[]`, preserving group order and each group's
 * task order exactly. The page may then regroup that flat list by one tag
 * type without duplicating tasks that carry multiple tags.
 *
 * Each task's `waitingFor` is displayed via `TaskRow`'s existing meta line;
 * when a task's own `waitingFor` is null/blank, `group.waitingFor` is used.
 * The API deliberately leaves the catch-all group as `null`, so the final
 * display fallback comes from the active frontend catalog.
 *
 * `position` is also rewritten to a sequential index matching this flat
 * order, since `TaskOutline` sorts its root tasks by `position` even when
 * `organizable` is false; the tasks here come from unrelated sibling groups
 * whose real `position` values aren't comparable across groups.
 */
function toDisplayTasks(
  groups: WaitingGroup[],
  unknownWaitingFor: string,
): Task[] {
  const tasks: Task[] = [];
  let position = 0;
  for (const group of groups) {
    for (const task of group.tasks) {
      const waitingFor = task.waitingFor?.trim()
        ? task.waitingFor
        : group.waitingFor?.trim() || unknownWaitingFor;
      tasks.push({ ...task, waitingFor, position: position++ });
    }
  }
  return tasks;
}

export function WaitingGroupList({
  groups,
  groupBy = null,
}: {
  groups: WaitingGroup[];
  groupBy?: GroupableTagKind | null;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [followUpTask, setFollowUpTask] = useState<Task | null>(null);
  const tasks = toDisplayTasks(groups, strings.unknown);
  const tagGroups = groupBy
    ? groupItemsByTagKind(tasks, groupBy, locale)
    : null;

  return (
    <>
      {groupBy && tagGroups ? (
        tagGroups.length > 0 ? (
          tagGroups.map((group) => (
            <CollapsibleGroup
              key={group.tag?.id ?? "none"}
              title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
              headingLevel={2}
            >
              <TaskOutline
                tasks={group.items}
                emptyMessage={strings.waitingEmpty}
                organizable={false}
                waitingInteraction={{ onFollowUp: setFollowUpTask }}
                showRevisitDate
                showSwipeHint={false}
              />
            </CollapsibleGroup>
          ))
        ) : (
          <TaskOutline
            tasks={[]}
            emptyMessage={strings.waitingEmpty}
            organizable={false}
            waitingInteraction={{ onFollowUp: setFollowUpTask }}
            showRevisitDate
            showSwipeHint={false}
          />
        )
      ) : (
        <TaskOutline
          tasks={tasks}
          emptyMessage={strings.waitingEmpty}
          organizable={false}
          waitingInteraction={{ onFollowUp: setFollowUpTask }}
          showRevisitDate
          showSwipeHint={false}
        />
      )}
      {followUpTask ? (
        <WaitingFollowUpSheet task={followUpTask} onClose={() => setFollowUpTask(null)} />
      ) : null}
    </>
  );
}

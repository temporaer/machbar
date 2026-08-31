import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { TaskOutline } from "./TaskOutline";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import {
  groupItemsByTagKind,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { useLocale } from "../lib/locale";

function uniqueDisplayTasks(tasks: Task[]): Task[] {
  const seen = new Set<number>();
  return tasks.flatMap((task, position) => {
    if (seen.has(task.id)) return [];
    seen.add(task.id);
    return [{ ...task, position }];
  });
}

export function WaitingGroupList({
  tasks: inputTasks,
  groupBy = null,
}: {
  tasks: Task[];
  groupBy?: GroupableTagKind | null;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [followUpTask, setFollowUpTask] = useState<Task | null>(null);
  const tasks = uniqueDisplayTasks(inputTasks);
  const tagGroups = groupBy
    ? groupItemsByTagKind(tasks, groupBy, locale)
    : null;
  const outline = (items: Task[]) => (
    <TaskOutline
      tasks={items}
      emptyMessage={strings.waitingEmpty}
      organizable={false}
      preserveRootOrder
      waitingInteraction={{ onFollowUp: setFollowUpTask }}
      showRevisitDate
      showSwipeHint={false}
    />
  );

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
              {outline(group.items)}
            </CollapsibleGroup>
          ))
        ) : (
          outline([])
        )
      ) : (
        outline(tasks)
      )}
      {followUpTask ? (
        <WaitingFollowUpSheet
          task={followUpTask}
          onClose={() => setFollowUpTask(null)}
        />
      ) : null}
    </>
  );
}

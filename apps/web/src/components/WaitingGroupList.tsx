import { useState } from "react";
import type { Task, WaitingEntry } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { TaskOutline } from "./TaskOutline";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import { CollapsibleGroup } from "./CollapsibleGroup";

function uniqueDisplayTasks(tasks: Task[]): Task[] {
  const seen = new Set<number>();
  return tasks.flatMap((task, position) => {
    if (seen.has(task.id)) return [];
    seen.add(task.id);
    return [{ ...task, position }];
  });
}

export function WaitingGroupList({
  entries,
}: {
  entries: WaitingEntry[];
}) {
  const strings = useStrings();
  const [followUpTask, setFollowUpTask] = useState<Task | null>(null);
  const externalTasks = uniqueDisplayTasks(
    entries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "external"),
      )
      .map((entry) => entry.task),
  );
  const contextTasks = uniqueDisplayTasks(
    entries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "context"),
      )
      .map((entry) => entry.task),
  );
  const outline = (items: Task[], external: boolean) => (
    <TaskOutline
      tasks={items}
      emptyMessage={strings.waitingEmpty}
      organizable={false}
      preserveRootOrder
      {...(external
        ? {
            waitingInteraction: { onFollowUp: setFollowUpTask },
            showRevisitDate: true,
          }
        : {})}
      showSwipeHint={false}
    />
  );

  return (
    <>
      {externalTasks.length > 0 ? (
        <CollapsibleGroup title={strings.waitingExternal} headingLevel={2}>
          {outline(externalTasks, true)}
        </CollapsibleGroup>
      ) : null}
      {contextTasks.length > 0 ? (
        <CollapsibleGroup title={strings.waitingContext} headingLevel={2}>
          <p className="text-muted">{strings.waitingContextHint}</p>
          {outline(contextTasks, false)}
        </CollapsibleGroup>
      ) : null}
      {externalTasks.length === 0 && contextTasks.length === 0
        ? outline([], false)
        : null}
      {followUpTask ? (
        <WaitingFollowUpSheet
          task={followUpTask}
          onClose={() => setFollowUpTask(null)}
        />
      ) : null}
    </>
  );
}

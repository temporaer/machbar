import type { Task, WaitingEntry } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { TaskOutlineInTransitionView } from "./TaskOutline";
import { CollapsibleGroup } from "./CollapsibleGroup";
import {
  TaskListTransitionFeedbackProvider,
  useRequiredTaskListTransitionFeedback,
} from "../lib/taskListTransitionFeedback";

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
  identityKey,
}: {
  entries: WaitingEntry[] | null;
  identityKey: string;
}) {
  return (
    <TaskListTransitionFeedbackProvider identityKey={identityKey}>
      <WaitingGroupListContent entries={entries} />
    </TaskListTransitionFeedbackProvider>
  );
}

function WaitingGroupListContent({
  entries,
}: {
  entries: WaitingEntry[] | null;
}) {
  const strings = useStrings();
  const feedback = useRequiredTaskListTransitionFeedback();
  const hasExternalTransition = feedback.hasTransitions("waiting:external");
  const hasContextTransition = feedback.hasTransitions("waiting:context");
  const resolvedEntries = entries ?? [];
  const externalCandidates = uniqueDisplayTasks(
    resolvedEntries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "external"),
      )
      .map((entry) => entry.task),
  );
  const contextCandidates = uniqueDisplayTasks(
    resolvedEntries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "context"),
      )
      .map((entry) => entry.task),
  );
  const externalTasks = externalCandidates;
  const contextTasks = contextCandidates;
  const outline = (items: Task[], external: boolean, transitionOutlineId: string) => (
    <TaskOutlineInTransitionView
      transitionOutlineId={transitionOutlineId}
      tasks={items}
      emptyMessage={strings.waitingEmpty}
      organizable={false}
      preserveRootOrder
      {...(external ? { showRevisitDate: true } : {})}
      showSwipeHint={false}
    />
  );

  return (
    <>
      {externalTasks.length > 0 || hasExternalTransition ? (
        <CollapsibleGroup title={strings.waitingExternal} headingLevel={2}>
          {outline(externalTasks, true, "waiting:external")}
        </CollapsibleGroup>
      ) : null}
      {contextTasks.length > 0 || hasContextTransition ? (
        <CollapsibleGroup title={strings.waitingContext} headingLevel={2}>
          <p className="text-muted">{strings.waitingContextHint}</p>
          {outline(contextTasks, false, "waiting:context")}
        </CollapsibleGroup>
      ) : null}
      {entries !== null &&
      externalTasks.length === 0 &&
      contextTasks.length === 0 &&
      !hasExternalTransition &&
      !hasContextTransition
        ? outline([], false, "waiting:empty")
        : null}
    </>
  );
}

import type { Task, WaitingEntry } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { TaskOutline } from "./TaskOutline";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { TaskTransitionEmptyState, TaskTransitionSection } from "../lib/taskTransitionPresentationContext";

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
  readSettled = true,
  readFailed = false,
}: {
  entries: WaitingEntry[];
  readSettled?: boolean;
  readFailed?: boolean;
}) {
  const strings = useStrings();
  const externalCandidates = uniqueDisplayTasks(
    entries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "external"),
      )
      .map((entry) => entry.task),
  );
  const externalIds = new Set(externalCandidates.map(task => task.id));
  const contextCandidates = uniqueDisplayTasks(
    entries
      .filter((entry) =>
        entry.reasons.some((reason) => reason.type === "context"),
      )
      .map((entry) => entry.task),
  ).filter(task => !externalIds.has(task.id));
  const externalTasks = externalCandidates;
  const contextTasks = contextCandidates;
  const outline = (items: Task[], external: boolean, sectionId: string) => (
    <TaskOutline
      tasks={items}
      emptyMessage={strings.waitingEmpty}
      organizable={false}
      preserveRootOrder
      {...(external ? { showRevisitDate: true } : {})}
      showSwipeHint={false}
      transitionSectionId={sectionId}
      transitionReadSettled={readSettled}
      transitionReadFailed={readFailed}
    />
  );

  return (
    <>
      <TaskTransitionSection sectionId="waiting-external" tasks={externalTasks}>
        <CollapsibleGroup title={strings.waitingExternal} headingLevel={2}>
          {outline(externalTasks, true, "waiting-external")}
        </CollapsibleGroup>
      </TaskTransitionSection>
      <TaskTransitionSection sectionId="waiting-context" tasks={contextTasks}>
        <CollapsibleGroup title={strings.waitingContext} headingLevel={2}>
          <p className="text-muted">{strings.waitingContextHint}</p>
          {outline(contextTasks, false, "waiting-context")}
        </CollapsibleGroup>
      </TaskTransitionSection>
      {externalTasks.length === 0 && contextTasks.length === 0
        ? <TaskTransitionEmptyState sectionIds={["waiting-external", "waiting-context"]}>
            {outline([], false, "waiting-empty")}
          </TaskTransitionEmptyState>
        : null}
    </>
  );
}

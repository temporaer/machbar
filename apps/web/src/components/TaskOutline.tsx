import { useMemo } from "react";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useSwipeSettings } from "../lib/swipeSettings";
import { OutlineOrganizeProvider, useOutlineOrganize } from "../lib/useOutlineOrganize";
import { NextActionBadgeProvider, type NextActionBadgeInfo } from "../lib/nextActionBadge";
import { TaskRow } from "./TaskRow";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { EmptyState } from "./AsyncStates";

export interface TaskOutlineProps {
  tasks: Task[];
  emptyMessage: string;
  /**
   * Opt in to structural editing (drag handle, keyboard moves). Only true
   * where `tasks` is a *complete* sibling group whose screen order is the
   * stored order — i.e. a project's own outline. Compiled views (Heute,
   * Eingang, Suche) show a filtered subset of tasks from unrelated groups,
   * so a position taken from screen order would be applied to the full
   * group on the server and silently shuffle rows the user never saw.
   * Refiling stays available there through the task detail sheet's
   * searchable pickers.
   */
  organizable?: boolean;
  /** Show the root tasks' external-wait revisit date as their follow-up prompt. */
  showRevisitDate?: boolean;
  showSwipeHint?: boolean;
  /** Preserve a compiled queue's root order instead of applying outline positions. */
  preserveRootOrder?: boolean;
  /**
   * Project-scoped derived/stored Next Action state (section 7). Only the
   * project's own outline passes this — see `ProjectDetailPage`.
   */
  nextActionInfo?: NextActionBadgeInfo;
}

export function TaskOutline({
  tasks,
  emptyMessage,
  organizable = false,
  showRevisitDate = false,
  showSwipeHint = true,
  preserveRootOrder = false,
  nextActionInfo,
}: TaskOutlineProps) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const { primarySwipeAction } = useSwipeSettings();
  const rightSwipeAction = strings.primarySwipeActionLabels[primarySwipeAction];
  // Structural editing (the drag gesture) keeps its own optimistic view of
  // the tree, so render what it hands back rather than the raw prop.
  const organize = useOutlineOrganize(tasks, organizable);

  // Root-level rows that just transitioned may no longer be present in
  // `tasks` once the compiled view (Heute/Eingang/Suche/…) refetches — see
  // `useTaskActions`'s retention window. Re-insert them (with their
  // optimistic status) at the end so the row keeps rendering instead of
  // disappearing the instant the underlying list updates.
  //
  // `presentIds` must cover the *whole* tree (every nested descendant), not
  // just root ids: a retained task that is a nested child stays nested
  // inside its still-present parent's `children` array and is rendered from
  // there. Checking only root ids would never find it there, so it would
  // wrongly get appended a second time as a duplicate top-level row on every
  // render while retained.
  //
  // They are kept *separate* from the real roots on purpose: a retention
  // ghost has no place in the stored sibling group, so it must not be
  // registered as a drop target (its slot would shift every index the drag
  // projects) nor offer a handle of its own. Rendering it outside the
  // organize provider below achieves both without any extra prop.
  const { roots, ghosts } = useMemo(() => {
    const sorted = preserveRootOrder ? organize.tasks : sortByPosition(organize.tasks);
    const presentIds = new Set(flattenTasks(sorted).map((t) => t.id));
    const stillRetained = [...taskActions.retained.values()].filter((t) => !presentIds.has(t.id));
    return { roots: sorted, ghosts: stillRetained };
  }, [organize.tasks, preserveRootOrder, taskActions.retained]);

  if (roots.length === 0 && ghosts.length === 0) return <EmptyState message={emptyMessage} />;

  const content = (
    <div className="task-outline" ref={organize.containerRef}>
      {showSwipeHint ? (
        <div className="row-between" style={{ marginBottom: 8 }}>
          <span className="text-muted">
            {strings.taskGestureHint(rightSwipeAction)}
          </span>
          {organize.enabled ? <span className="text-muted">{strings.dragHint}</span> : null}
        </div>
      ) : null}
      <OutlineOrganizeProvider value={organize.value}>
        <ul className="list" style={{ padding: 0, margin: 0 }}>
          {roots.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              parentTask={null}
              depth={0}
              showRevisitDate={showRevisitDate}
            />
          ))}
        </ul>
      </OutlineOrganizeProvider>
      {ghosts.length > 0 ? (
        // `marginTop` replaces the flex `gap` the two lists cannot share.
        <ul className="list" style={{ padding: 0, margin: "8px 0 0" }}>
          {ghosts.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              parentTask={null}
              depth={0}
              showRevisitDate={showRevisitDate}
            />
          ))}
        </ul>
      ) : null}
      {organize.projection ? (
        <div
          className="task-drop-indicator"
          data-testid="task-drop-indicator"
          data-depth={organize.projection.depth}
          aria-hidden="true"
          style={{
            top: organize.indicatorTop,
            marginLeft: organize.projection.depth * organize.indentWidth,
          }}
        />
      ) : null}
      {/* A drag has no visual meaning for assistive tech — announce the live drop target. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {organize.announcement}
      </p>
      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "complete"}
          onChoose={taskActions.resolvePolicy}
          onClose={taskActions.cancelPrompt}
        />
      ) : null}
    </div>
  );

  return nextActionInfo ? (
    <NextActionBadgeProvider value={nextActionInfo}>{content}</NextActionBadgeProvider>
  ) : (
    content
  );
}

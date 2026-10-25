import { useLayoutEffect } from "react";
import { useRetainedPlacement } from "../lib/useRetainedPlacement";
import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { applyDescendantTerminalOutcome, flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { OutlineOrganizeProvider, useOutlineOrganize } from "../lib/useOutlineOrganize";
import { NextActionBadgeProvider, type NextActionBadgeInfo } from "../lib/nextActionBadge";
import { TaskRow } from "./TaskRow";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { EmptyState } from "./AsyncStates";
import type { AttentionTone } from "../lib/attentionTone";

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
  /**
   * Compiled-view presentation: root tasks stay full-featured, but every
   * *descendant* (any depth below the outline's own roots) renders as a
   * compact row (title + status control + only high-value signals) and
   * hides entirely-terminal (done/cancelled) descendant subtrees behind an
   * inline "N erledigt anzeigen" affordance. Descendants keep the compiled
   * traversal order, since promoted rows can have different original parents.
   * Used on Today; Project Detail
   * keeps the default `false` full outline.
   */
  compactDescendants?: boolean;
  /** Optional Today-only emphasis shared by every row in this compiled list. */
  attentionTone?: AttentionTone;
}

export function TaskOutline({
  tasks,
  emptyMessage,
  organizable = false,
  showRevisitDate = false,
  showSwipeHint = true,
  preserveRootOrder = false,
  nextActionInfo,
  compactDescendants = false,
  attentionTone,
}: TaskOutlineProps) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  // Structural editing (the drag gesture) keeps its own optimistic view of
  // the tree, so render what it hands back rather than the raw prop.
  const organize = useOutlineOrganize(tasks, organizable);

  const sorted = preserveRootOrder ? organize.tasks : sortByPosition(organize.tasks);
  useLayoutEffect(() => { taskActions.observeTasks(sorted); }, [sorted, taskActions.observeTasks]);
  const { rows: roots } = useRetainedPlacement({ rows: sorted }, taskActions.holdingIds,
    task => {
      const overlay = taskActions.retained.get(task.id);
      return overlay && overlay.revision >= task.revision ? overlay : task;
    }, "", applyDescendantTerminalOutcome);
  const actualIds = new Set(flattenTasks(organize.tasks).map(task => task.id));
  if (roots.length === 0) return <EmptyState message={emptyMessage} />;

  const content = (
    <div className="task-outline" ref={organize.containerRef}>
      {showSwipeHint ? (
        <div className="row-between" style={{ marginBottom: 8 }}>
          <span className="text-muted">
            {strings.taskGestureHint}
          </span>
          {organize.enabled ? <span className="text-muted">{strings.dragHint}</span> : null}
        </div>
      ) : null}
      <ul className="list" style={{ padding: 0, margin: 0 }}>
        {roots.map(task => {
          const row = <TaskRow task={task} parentTask={null} depth={0}
            showRevisitDate={showRevisitDate} compactDescendants={compactDescendants}
            {...(attentionTone ? { attentionTone } : {})} />;
          return <OutlineOrganizeProvider key={task.id} value={actualIds.has(task.id) ? organize.value : null}>{row}</OutlineOrganizeProvider>;
        })}
      </ul>
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

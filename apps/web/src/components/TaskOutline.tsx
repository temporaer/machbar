import { useMemo, useState } from "react";
import type { Task } from "@machbar/shared";
import { strings } from "../lib/strings";
import { flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { useTaskActions } from "../lib/useTaskActions";
import { useSwipeSettings } from "../lib/swipeSettings";
import { TaskRow } from "./TaskRow";
import { MoveTaskSheet } from "./MoveTaskSheet";
import type { MoveMode } from "./MoveTaskSheet";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { EmptyState } from "./AsyncStates";
import { useTaskDetail } from "../lib/taskDetailContext";

export function TaskOutline({ tasks, emptyMessage }: { tasks: Task[]; emptyMessage: string }) {
  const [organizeMode, setOrganizeMode] = useState(false);
  const [movePrompt, setMovePrompt] = useState<{ task: Task; mode: MoveMode } | null>(null);
  const taskActions = useTaskActions();
  const { open } = useTaskDetail();
  const { primarySwipeAction } = useSwipeSettings();

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
  const roots = useMemo(() => {
    const sorted = sortByPosition(tasks);
    const presentIds = new Set(flattenTasks(sorted).map((t) => t.id));
    const stillRetained = [...taskActions.retained.values()].filter((t) => !presentIds.has(t.id));
    return [...sorted, ...stillRetained];
  }, [tasks, taskActions.retained]);

  if (roots.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <span className="text-muted">
          {organizeMode
            ? strings.longPressHint
            : `${strings.primarySwipeActionLabels[primarySwipeAction]} · ${strings.swipeHintChips}`}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => setOrganizeMode((m) => !m)} aria-pressed={organizeMode}>
          {organizeMode ? strings.exitOrganizeMode : strings.organize}
        </button>
      </div>
      <ul className="list" style={{ padding: 0, margin: 0 }}>
        {roots.map((task, i) => (
          <TaskRow
            key={task.id}
            task={task}
            parentTask={null}
            depth={0}
            index={i}
            siblings={roots}
            organizeMode={organizeMode}
            onEnterOrganizeMode={() => setOrganizeMode(true)}
            onOpenDetail={open}
            onPickParent={(t) => setMovePrompt({ task: t, mode: "parent" })}
            onPickProject={(t, subtree) => setMovePrompt({ task: t, mode: subtree ? "subtree" : "project" })}
            taskActions={taskActions}
          />
        ))}
      </ul>
      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "complete"}
          onChoose={taskActions.resolvePolicy}
          onClose={taskActions.cancelPrompt}
        />
      ) : null}
      {movePrompt ? (
        <MoveTaskSheet task={movePrompt.task} mode={movePrompt.mode} onClose={() => setMovePrompt(null)} />
      ) : null}
    </div>
  );
}

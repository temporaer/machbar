import type { TaskListRow, TaskListTransitionEntry } from "../lib/taskListTransitionPresentation";
import { useStrings } from "../lib/strings";
import type { AttentionTone } from "../lib/attentionTone";
import { TaskCardTags } from "./TaskCardTags";

export function TaskTransitionRow({
  transition,
  ancestor,
  nestedRows,
  attentionTone,
  compact = false,
}: {
  transition?: TaskListTransitionEntry;
  ancestor?: Extract<TaskListRow, { kind: "ancestor" }>;
  nestedRows?: TaskListRow[];
  attentionTone?: AttentionTone;
  compact?: boolean;
}) {
  const strings = useStrings();
  if (ancestor) {
    return (
      <li
        className={`task-row task-row-transition-ancestor${attentionTone ? ` task-row-attention-${attentionTone}` : ""}`}
        style={{ listStyle: "none" }}
        aria-disabled="true"
      >
        <div className={`task-row-content has-owner${compact ? " compact" : ""}`}>
          <div className="task-row-leading-controls" aria-hidden="true">
            <span className="task-row-checkbox" />
          </div>
          <div className="task-row-main-wrap">
            <div className="task-row-main">
              <div className="task-row-header">
                <div className="task-row-title">{ancestor.title}</div>
              </div>
            </div>
          </div>
        </div>
        <NestedTransitionRows
          rows={ancestor.children}
          compact={compact}
          {...(attentionTone ? { attentionTone } : {})}
        />
      </li>
    );
  }
  if (!transition) return null;
  const { task, event } = transition;
  const pending = event.phase === "pending";
  const status = event.occurrence
    ? event.resultStatus ?? task.status
    : pending
      ? event.targetStatus
      : event.resultStatus ?? event.targetStatus;
  const done = status === "done" && !event.occurrence;
  const cancelled = status === "cancelled";
  const message = event.occurrence
    ? pending ? strings.taskOccurrencePending : strings.taskOccurrenceCompleted
    : pending
      ? strings.taskTransitionPending(status)
      : strings.taskTransitionConfirmed(status);

  return (
    <li
      className={`task-row task-row-transition-row task-row-transition-${event.phase} task-row-surface-${status}${event.occurrence ? " task-row-occurrence" : ""}${attentionTone ? ` task-row-attention-${attentionTone}` : ""}`}
      style={{ listStyle: "none" }}
      aria-disabled="true"
    >
      <div className={`task-row-content has-owner${compact ? " compact" : ""}`} aria-busy={pending || undefined}>
        <div className="task-row-leading-controls" aria-hidden="true">
          <span className={`task-row-checkbox${done ? " done" : ""}${cancelled ? " cancelled" : ""}${event.occurrence ? " occurrence" : ""}`}>
            {done || event.occurrence ? "✓" : cancelled ? "×" : ""}
          </span>
        </div>
        <div className="task-row-main-wrap">
          <div className="task-row-main">
            <div className="task-row-header">
              <TaskCardTags tags={task.effectiveTags} contexts={task.effectiveContexts} />
              <div className={`task-row-title${done ? " done" : ""}${cancelled ? " cancelled" : ""}`}>
                {task.title}
              </div>
            </div>
            {status !== "actionable" ? (
              <div className="task-row-meta">
                <span className={`task-row-meta-item task-row-state task-row-state-${status}`}>
                  {strings.taskStatusLabels[status]}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div
        className={`task-row-transition-feedback${pending ? "" : " confirmed"}`}
        role="status"
        aria-live="polite"
      >
        {message}
      </div>
      <NestedTransitionRows
        rows={nestedRows ?? []}
        compact={compact}
        {...(attentionTone ? { attentionTone } : {})}
      />
    </li>
  );
}

function NestedTransitionRows({
  rows,
  compact,
  attentionTone,
}: {
  rows: TaskListRow[];
  compact: boolean;
  attentionTone?: AttentionTone;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="task-row-children">
      {rows.map(row => row.kind === "transition" || row.kind === "ancestor" ? (
        <TaskTransitionRow
          key={row.kind === "transition" ? `transition-${row.transition.event.taskId}` : `ancestor-${row.taskId}`}
          {...(row.kind === "transition" ? { transition: row.transition, nestedRows: row.children } : { ancestor: row })}
          compact={compact}
          {...(attentionTone ? { attentionTone } : {})}
        />
      ) : null)}
    </ul>
  );
}

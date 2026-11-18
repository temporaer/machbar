import type { ReactNode } from "react";
import { useStrings } from "../lib/strings";
import type { TaskDisplayNode, TaskTransitionOperation } from "../lib/taskTransitionPresentation";
import type { TaskTransitionDisplayItem } from "../lib/taskTransitionPresentationContext";

export function TaskTransitionDepartureRow({
  node,
  operation,
  children,
}: {
  node: TaskDisplayNode;
  operation: TaskTransitionOperation | null;
  children?: ReactNode;
}) {
  const strings = useStrings();
  const snapshot = node.snapshot;
  const label = operation
    ? operation.phase === "confirmed"
      ? operation.recurringOccurrence
        ? strings.taskTransitionOccurrence
        : strings.taskTransitionConfirmed[operation.intent]
      : strings.taskTransitionPending[operation.intent]
    : null;
  const completed = snapshot?.status === "done" ||
    (operation?.resultStatus === "done" && !operation.recurringOccurrence);
  return (
    <>
      <li
        className={`task-row task-row-transition-departure${snapshot ? ` task-row-surface-${snapshot.status}` : " task-row-transition-shell"}`}
        style={{ listStyle: "none" }}
        aria-disabled="true"
      >
        <div className="task-row-content">
          {snapshot ? (
            <span className={`task-row-checkbox${completed ? " done" : ""}`} aria-hidden="true">
              {completed ? "✓" : ""}
            </span>
          ) : null}
          <div className="task-row-main">
            {snapshot ? (
              <div className={`task-row-title${completed ? " done" : ""}`}>
                {snapshot.title}
              </div>
            ) : (
              <div className="task-row-title">{node.shellTitle ?? ""}</div>
            )}
          </div>
        </div>
        {label ? <p className="task-row-transition-status" role="status" aria-live="polite">{label}</p> : null}
        {children}
      </li>
    </>
  );
}

export function TaskTransitionDepartureChildren({
  items,
  getOperation,
}: {
  items: TaskTransitionDisplayItem[];
  getOperation(nodeKey: string): TaskTransitionOperation | null;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="task-row-children">
      {items.map(item => item.kind === "departure" ? (
        <TaskTransitionDepartureRow
          key={item.node.key}
          node={item.node}
          operation={getOperation(item.node.key)}
        >
          <TaskTransitionDepartureChildren items={item.children} getOperation={getOperation} />
        </TaskTransitionDepartureRow>
      ) : null)}
    </ul>
  );
}

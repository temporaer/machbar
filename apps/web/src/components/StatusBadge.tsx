import type { ProjectStatus, TaskStatus } from "@machbar/shared";
import { useStrings } from "../lib/strings";

/**
 * Plain by default (used in compact lists like the Teilaufgaben rows), but
 * renders as a real button matching the other `.detail-meta-button` pills
 * when `onClick` is given — its only interactive use is the task detail
 * meta row, which dispatches `task.lifecycle` through it.
 */
export function StatusBadge({
  status,
  onClick,
}: {
  status: TaskStatus;
  onClick?: () => void;
}) {
  const strings = useStrings();
  const text = strings.taskStatusLabels[status];
  if (onClick) {
    return (
      <button
        type="button"
        className={`detail-meta-button detail-meta-status-button status-${status}`}
        onClick={onClick}
      >
        <span className="detail-meta-label">{strings.status}</span>
        <span>{text}</span>
      </button>
    );
  }
  return <span className={`badge badge-status-${status}`}>{text}</span>;
}

/**
 * Project-status counterpart to `StatusBadge` above, sharing the exact same
 * `detail-meta-button`/`detail-meta-status-button` pill grammar (see the CSS
 * rules colocated with Task's `status-*` variants) parameterized for
 * `ProjectStatus`'s four values instead of `TaskStatus`'s five. Project
 * status has one call site (the `ProjectDetailPage` overview badge) and is
 * always clickable there, unlike Task's status which is read-only for
 * captured Inbox items.
 */
export function ProjectStatusBadge({
  status,
  onClick,
  disabled,
}: {
  status: ProjectStatus;
  onClick: () => void;
  disabled?: boolean;
}) {
  const strings = useStrings();
  const text = strings.projectStatusLabels[status];
  return (
    <button
      type="button"
      className={`detail-meta-button detail-meta-status-button status-${status}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="detail-meta-label">{strings.status}</span>
      <span>{text}</span>
    </button>
  );
}

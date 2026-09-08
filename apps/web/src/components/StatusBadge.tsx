import type { TaskStatus } from "@machbar/shared";
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

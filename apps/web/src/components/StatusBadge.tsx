import type { TaskStatus } from "@machbar/shared";
import { taskStatusLabels } from "../lib/strings";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge badge-status-${status}`}>{taskStatusLabels[status]}</span>;
}

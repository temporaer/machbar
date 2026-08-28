import type { TaskStatus } from "@machbar/shared";
import { useStrings } from "../lib/strings";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const strings = useStrings();
  return <span className={`badge badge-status-${status}`}>{strings.taskStatusLabels[status]}</span>;
}

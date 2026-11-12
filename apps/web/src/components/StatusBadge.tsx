import type { ProjectStatus, TaskStatus } from "@machbar/shared";
import { useStrings } from "../lib/strings";

type StatusControlProps = {
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
  controls?: string;
};

function StatusControl({ status, text, onClick, disabled, busy, expanded, controls }: StatusControlProps & { status: string; text: string }) {
  const strings = useStrings();
  return <button type="button"
    className={`detail-meta-button detail-meta-status-button status-${status}`}
    disabled={disabled || busy} aria-expanded={expanded} aria-controls={controls}
    aria-busy={busy || undefined} onClick={onClick}>
    <span className="sr-only">{strings.status} </span>
    <span>{busy ? strings.saving : text}</span>
    <span aria-hidden="true">▾</span>
  </button>;
}

/** List badges remain read-only; detail controls disclose canonical lifecycle actions. */
export function StatusBadge({ status, ...props }: StatusControlProps & { status: TaskStatus }) {
  const strings = useStrings();
  const text = strings.taskStatusLabels[status];
  return props.onClick ? <StatusControl status={status} text={text} {...props} />
    : <span className={`badge badge-status-${status}`}>{text}</span>;
}

export function ProjectStatusBadge({ status, ...props }: StatusControlProps & { status: ProjectStatus; onClick: () => void }) {
  const strings = useStrings();
  return <StatusControl status={status} text={strings.projectStatusLabels[status]} {...props} />;
}

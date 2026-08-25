import type { MouseEventHandler } from "react";

export type TaskActionIconKind =
  | "owner"
  | "schedule"
  | "notes"
  | "child"
  | "project"
  | "waiting"
  | "actionable"
  | "reopen"
  | "followUp"
  | "more";

function Glyph({ kind }: { kind: TaskActionIconKind }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === "owner" ? (
        <>
          <circle cx="12" cy="8" r="3.5" {...common} />
          <path d="M4.5 20c0-4.2 3.3-6.8 7.5-6.8s7.5 2.6 7.5 6.8" {...common} />
        </>
      ) : kind === "schedule" ? (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="2" {...common} />
          <path d="M3.5 9.5h17M8 3v4M16 3v4" {...common} />
        </>
      ) : kind === "notes" ? (
        <>
          <path d="M5 3.5h10l4 4V20H5zM15 3.5V8h4M8 12h8M8 16h6" {...common} />
        </>
      ) : kind === "child" ? (
        <>
          <path d="M5 5v8h7M9 10l3 3-3 3" {...common} />
          <path d="M17 12v8M13 16h8" {...common} />
        </>
      ) : kind === "project" ? (
        <path d="M3.5 6.5h6l2 2h9v10.5h-17z" {...common} />
      ) : kind === "waiting" ? (
        <>
          <path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 1.4 6 4 8-2.6 2-4 4-4 9M16 3.5c0 4-1.4 6-4 8 2.6 2 4 4 4 9" {...common} />
        </>
      ) : kind === "actionable" ? (
        <path d="M7 4.5l11 7.5L7 19.5z" {...common} />
      ) : kind === "reopen" ? (
        <path d="M5 8V3.5M5 3.5h4.5M5.5 4.5A8 8 0 1 1 4 14" {...common} />
      ) : kind === "followUp" ? (
        <>
          <path d="M4 5h16v10.5H10L5 20v-4.5H4z" {...common} />
          <path d="M12 8v3.2M12 13.7v.01" {...common} />
        </>
      ) : (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" {...common} />
          <circle cx="9" cy="6" r="1.6" fill="currentColor" />
          <circle cx="15" cy="12" r="1.6" fill="currentColor" />
          <circle cx="8" cy="18" r="1.6" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export function TaskActionIcon({
  kind,
  label,
  title = label,
  disabled,
  onClick,
}: {
  kind: TaskActionIconKind;
  label: string;
  title?: string | undefined;
  disabled?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="task-row-chip-icon"
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Glyph kind={kind} />
    </button>
  );
}

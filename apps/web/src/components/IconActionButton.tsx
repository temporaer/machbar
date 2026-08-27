import type { MouseEventHandler } from "react";

export type IconActionKind =
  | "owner"
  | "criteria"
  | "schedule"
  | "tags"
  | "openProject"
  | "notes"
  | "child"
  | "successor"
  | "project"
  | "waiting"
  | "actionable"
  | "reopen"
  | "followUp"
  | "more";

export function IconActionGlyph({ kind }: { kind: IconActionKind }) {
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
          <circle cx="12" cy="8" r="3.6" {...common} />
          <path d="M4.5 19.5c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" {...common} />
        </>
      ) : kind === "criteria" ? (
        <>
          <path d="M3.5 6.5l1.7 1.7L8 5M11 6.2h9.5M3.5 14.5l1.7 1.7L8 13M11 14.2h9.5" {...common} />
        </>
      ) : kind === "schedule" ? (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="2.2" {...common} />
          <path d="M3.5 9.7h17M8 3v4M16 3v4" {...common} />
        </>
      ) : kind === "tags" ? (
        <>
          <path d="M3.5 12.2V5.5a2 2 0 012-2h6.7l8.3 8.3a2 2 0 010 2.8l-5.9 5.9a2 2 0 01-2.8 0L3.5 12.2z" {...common} />
          <circle cx="8.1" cy="8.1" r="1.4" fill="currentColor" />
        </>
      ) : kind === "openProject" ? (
        <path d="M5 19h14V5M10 5h9v9M18.5 5.5L9 15" {...common} />
      ) : kind === "notes" ? (
        <path d="M5 3.5h10l4 4V20H5zM15 3.5V8h4M8 12h8M8 16h6" {...common} />
      ) : kind === "child" ? (
        <>
          <path d="M5 5v8h7M9 10l3 3-3 3" {...common} />
          <path d="M17 12v8M13 16h8" {...common} />
        </>
      ) : kind === "successor" ? (
        <>
          <path d="M4 12h13M13 8l4 4-4 4" {...common} />
          <path d="M20 6v12" {...common} />
        </>
      ) : kind === "project" ? (
        <path d="M3.5 6.5h6l2 2h9v10.5h-17z" {...common} />
      ) : kind === "waiting" ? (
        <path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 1.4 6 4 8-2.6 2-4 4-4 9M16 3.5c0 4-1.4 6-4 8 2.6 2 4 4 4 9" {...common} />
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

/** Shared 44px icon-only action control used by task and project swipe strips. */
export function IconActionButton({
  kind,
  label,
  title = label,
  disabled,
  onClick,
}: {
  kind: IconActionKind;
  label: string;
  title?: string | undefined;
  disabled?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="icon-action-button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <IconActionGlyph kind={kind} />
    </button>
  );
}

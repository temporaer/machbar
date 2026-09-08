import { useEffect, useId, useState, type ReactNode, type Ref } from "react";

/**
 * The one collapsible-section primitive shared by the WorkItem detail
 * surfaces (`TaskDetailSheet.tsx`, `ProjectDetailPage.tsx`).
 *
 * Neither surface has always-visible field groups any more — scalar
 * properties are meta-row values that dispatch semantic commands — so the
 * former always-open `WorkItemDetailSection` companion is gone and only the
 * disclosure remains.
 */
export function WorkItemDetailDisclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  forceOpen = false,
  resetKey,
  detailsRef,
  className = "",
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  resetKey?: number;
  detailsRef?: Ref<HTMLDetailsElement>;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen, resetKey]);

  return (
    <details
      ref={detailsRef}
      className={`task-detail-section task-detail-disclosure${className ? ` ${className}` : ""}`}
      open={open || forceOpen}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-detail-section-title disclosure-summary">
        <span className="task-detail-disclosure-heading">
          <span role="heading" aria-level={3}>
            {title}
          </span>
          {summary ? (
            <span className="task-detail-disclosure-summary">{summary}</span>
          ) : null}
        </span>
      </summary>
      <div className="task-detail-section-body">{children}</div>
    </details>
  );
}

import { useEffect, useId, useState, type ReactNode } from "react";

/**
 * Shared section/disclosure primitives for the WorkItem detail surfaces
 * (`TaskDetailSheet.tsx`, `ProjectEditSheet.tsx`). Both previously defined
 * their own near-identical `*Section`/`*Disclosure` components against the
 * same `.task-detail-section`/`.task-detail-disclosure` CSS classes — this
 * is the one shared implementation both now use, per the "common WorkItem
 * inspector... common sections" architecture (see `docs/architecture-rules.md`).
 *
 * A full merge of the two sheets into one unified inspector component is a
 * larger, separately-scoped effort; this is the safely-extractable shared
 * piece that doesn't require unifying the
 * rest of either sheet's task-specific/story-specific field logic.
 */
export function WorkItemDetailSection({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      className={`task-detail-section${className ? ` ${className}` : ""}`}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="task-detail-section-title">
        {title}
      </h3>
      <div className="task-detail-section-body">{children}</div>
    </section>
  );
}

export function WorkItemDetailDisclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  forceOpen = false,
  resetKey,
  className = "",
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  resetKey?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen, resetKey]);

  return (
    <details
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

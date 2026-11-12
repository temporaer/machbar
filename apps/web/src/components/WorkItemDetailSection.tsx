import { useEffect, useState, type ReactNode, type Ref } from "react";

/**
 * The one collapsible-section primitive shared by the WorkItem detail
 * surfaces (`TaskDetailSheet.tsx`, `ProjectDetailPage.tsx`).
 *
 * Heading actions remain outside the native summary so editing and
 * disclosure navigation are independent, including while collapsed.
 */
export function WorkItemDetailDisclosure({
  title,
  summary,
  actions,
  headingLevel = 3,
  children,
  defaultOpen = false,
  forceOpen = false,
  resetKey,
  detailsRef,
  className = "",
}: {
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
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

  const disclosure = (
    <details
      ref={detailsRef}
      className={`task-detail-section task-detail-disclosure${className ? ` ${className}` : ""}`}
      open={open || forceOpen}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-detail-section-title disclosure-summary">
        <span className="task-detail-disclosure-heading">
          <span role="heading" aria-level={headingLevel}>
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
  return actions ? (
    <section className="detail-disclosure-with-actions">
      {disclosure}
      <div className="detail-disclosure-actions">{actions}</div>
    </section>
  ) : disclosure;
}

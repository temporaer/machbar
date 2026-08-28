import { useState, type ReactNode } from "react";

export function CollapsibleGroup({
  title,
  headingLevel,
  children,
}: {
  title: string;
  headingLevel: 2 | 3;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <details
      className="section collapsible-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="section-title disclosure-summary">
        <span role="heading" aria-level={headingLevel}>
          {title}
        </span>
      </summary>
      {children}
    </details>
  );
}

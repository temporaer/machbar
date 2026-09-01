import { useState, type ReactNode } from "react";

export function CollapsibleGroup({
  title,
  headingLevel,
  defaultOpen = true,
  children,
}: {
  title: string;
  headingLevel: 2 | 3;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

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

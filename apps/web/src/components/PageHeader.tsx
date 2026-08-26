import { useId, useState, type ReactNode } from "react";
import { strings } from "../lib/strings";

export type PageHint = {
  label?: string;
  text: string | readonly string[];
};

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  hints?: readonly PageHint[];
};

export function PageHeader({ title, actions, hints = [] }: PageHeaderProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const hasHints = hints.length > 0;

  return (
    <>
      <div className="page-header">
        <h1>{title}</h1>
        {actions || hasHints ? (
          <div className="page-header-actions">
            {actions}
            {hasHints ? (
              <button
                type="button"
                className="page-info-button"
                aria-label={helpOpen ? strings.hidePageHints : strings.showPageHints}
                aria-expanded={helpOpen}
                aria-controls={helpId}
                onClick={() => setHelpOpen((open) => !open)}
              >
                <span aria-hidden="true">i</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {hasHints && helpOpen ? (
        <aside
          id={helpId}
          className="page-info-callout"
          aria-label={strings.pageHints}
        >
          {hints.map((hint, index) => {
            const lines = typeof hint.text === "string" ? [hint.text] : hint.text;
            return (
              <div className="page-info-hint" key={`${hint.label ?? "hint"}-${index}`}>
                {hint.label ? <strong>{hint.label}</strong> : null}
                {lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            );
          })}
        </aside>
      ) : null}
    </>
  );
}

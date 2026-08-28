import { useId, useState, type ReactNode } from "react";
import { useStrings } from "../lib/strings";

export type PageHint = {
  label?: string;
  text: string | readonly string[];
};

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  hints?: readonly PageHint[];
  headingLevel?: 1 | 2;
};

export function PageHeader({
  title,
  actions,
  hints = [],
  headingLevel = 1,
}: PageHeaderProps) {
  const strings = useStrings();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const hasHints = hints.length > 0;
  const heading =
    headingLevel === 1 ? <h1>{title}</h1> : <h2 className="section-title">{title}</h2>;

  return (
    <>
      <div className="page-header">
        {heading}
        {actions || hasHints ? (
          <div className="page-header-actions">
            {actions}
            {hasHints ? (
              <button
                type="button"
                className="page-header-button page-info-button"
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

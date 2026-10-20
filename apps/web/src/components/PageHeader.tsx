import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
};

export function PageHeader({ title, actions, headingLevel = 1 }: PageHeaderProps) {
  return (
    <div className="page-header">
      {headingLevel === 1 ? <h1>{title}</h1> : <h2 className="section-title">{title}</h2>}
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}

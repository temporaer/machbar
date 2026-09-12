import type { WorkItemAncestor } from "@machbar/shared";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";

/**
 * Generic hierarchy breadcrumb trail for detail views (task detail, project
 * detail). Renders ancestors only -- never the current item -- and contains
 * no routing/sheet logic of its own: every click dispatches the semantic
 * `workItem.open` command, and `useWorkItemCommands()` decides whether that
 * means swapping the open task-detail sheet or navigating to a project
 * route. Keeping that decision centralized is what lets task ancestors and
 * story ancestors share one component.
 */
export function WorkItemBreadcrumbs({ ancestors }: { ancestors: WorkItemAncestor[] }) {
  const dispatch = useWorkItemCommands();

  if (ancestors.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="work-item-breadcrumbs">
      <ol className="work-item-breadcrumbs-list">
        {ancestors.map((ancestor, index) => (
          <li key={`${ancestor.role}-${ancestor.id}`} className="work-item-breadcrumbs-item">
            <button
              type="button"
              className="work-item-breadcrumbs-link"
              onClick={() => dispatch({ type: "workItem.open", workItem: ancestor })}
            >
              {ancestor.title}
            </button>
            {index < ancestors.length - 1 ? (
              <span className="work-item-breadcrumbs-separator" aria-hidden="true">
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

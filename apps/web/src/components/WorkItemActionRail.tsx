interface WorkItemActionRailProps {
  kind: "task" | "project";
  disabled?: boolean;
  groupLabel: string;
  emptyLabel: string;
  actions: readonly {
    id: string;
    label: string;
    accessibleLabel: string;
    prominent?: boolean;
    onSelect: () => void;
  }[];
}

/** One non-wrapping row of contextual interventions, selected by workItemRail.ts. */
export function WorkItemActionRail({ kind, disabled = false, groupLabel, emptyLabel, actions }: WorkItemActionRailProps) {
  return (
    <div className="work-item-command-rail" data-kind={kind} role="group" aria-label={groupLabel}>
      {actions.length ? <div className="rail-main-grid" style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`btn btn-sm${action.prominent ? " btn-primary" : ""}`}
            aria-label={action.accessibleLabel}
            title={action.accessibleLabel}
            disabled={disabled}
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        ))}
      </div> : <p className="rail-empty" role="status">{emptyLabel}</p>}
    </div>
  );
}

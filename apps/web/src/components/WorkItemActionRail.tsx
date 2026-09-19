interface WorkItemActionRailProps {
  kind: "task" | "project";
  disabled?: boolean;
  groupLabel: string;
  actions: readonly {
    label: string;
    onSelect: () => void;
  }[];
}

/**
 * Fixed row rail shared by tasks and projects — replaces the
 * former user-configurable favorites/overflow rail
 * (`railConfig.ts`/`railConfigContext.tsx`/`WorkItemCommandRail.tsx`):
 * receives the fixed actions for the current item in display order. Tasks use
 * **Ab … · Einplanen · Mehr**; projects keep their own revisit/structure
 * labels. `Mehr` opens the item's
 * detail directly — it is not another overflow menu. Status/lifecycle
 * transitions (and, for tasks, waiting/follow-up) live in the separate
 * status rail, not here — see `TaskRow.tsx`'s/`ProjectStoryRow.tsx`'s
 * `*-row-lifecycle` group.
 */
export function WorkItemActionRail({
  kind,
  disabled = false,
  groupLabel,
  actions,
}: WorkItemActionRailProps) {
  return (
    <div className="work-item-command-rail" data-kind={kind} role="group" aria-label={groupLabel}>
      <div
        className="rail-main-grid"
        style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

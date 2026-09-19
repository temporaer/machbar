interface WorkItemActionRailProps {
  kind: "task" | "project";
  disabled?: boolean;
  groupLabel: string;
  laterLabel: string;
  structureLabel: string;
  moreLabel: string;
  onLater?: () => void;
  onStructure: () => void;
  onMore: () => void;
}

/**
 * Fixed row rail shared by tasks and projects — replaces the
 * former user-configurable favorites/overflow rail
 * (`railConfig.ts`/`railConfigContext.tsx`/`WorkItemCommandRail.tsx`):
 * always in this order, never configurable. Tasks use
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
  laterLabel,
  structureLabel,
  moreLabel,
  onLater,
  onStructure,
  onMore,
}: WorkItemActionRailProps) {
  return (
    <div className="work-item-command-rail" data-kind={kind} role="group" aria-label={groupLabel}>
      <div className="rail-main-grid">
        {onLater ? (
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={onLater}>
            {laterLabel}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={onStructure}>
          {structureLabel}
        </button>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={onMore}>
          {moreLabel}
        </button>
      </div>
    </div>
  );
}

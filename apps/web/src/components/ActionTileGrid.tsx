import { IconActionGlyph, type IconActionKind } from "./IconActionButton";

export interface ActionTileDescriptor {
  key: string;
  icon: IconActionKind;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Genuine-action surface for Task/Project detail views' `Weitere Aktionen`:
 * unlike the fixed `Später`/`Struktur` rail (see `WorkItemActionRail`), this
 * renders each item as a large tappable tile with a mnemonic icon *and* an
 * always-visible verb label -- never icon-only -- sized for a ~44-52px
 * target. Detail views pass only genuinely uncommon commands that have no
 * other direct affordance (see callers).
 */
export function ActionTileGrid({ items }: { items: readonly ActionTileDescriptor[] }) {
  if (items.length === 0) return null;
  return (
    <div className="action-tile-grid">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="action-tile"
          disabled={item.disabled}
          onClick={item.onClick}
        >
          <IconActionGlyph kind={item.icon} />
          <span className="action-tile-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

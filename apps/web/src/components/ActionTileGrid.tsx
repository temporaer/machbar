import { IconActionGlyph, type IconActionKind } from "./IconActionButton";

export interface ActionTileDescriptor {
  key: string;
  icon: IconActionKind;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Genuine-action surface for Task/Project detail views: unlike
 * `CommandCategoryGrid` (a flat command dump still used by the swipe
 * rail's own "More…" overflow, see `WorkItemCommandRail`), this renders
 * each item as a large tappable tile with a mnemonic icon *and* an
 * always-visible verb label -- never icon-only -- sized for a ~44-52px
 * target. Detail views pass only commands that are not already directly
 * represented elsewhere on the page (see callers).
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

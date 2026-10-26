import { IconActionGlyph, type IconActionKind } from "./IconActionButton";

export interface ActionTileDescriptor {
  key: string;
  icon: IconActionKind;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** Labelled semantic action choices. DetailActionMenu supplies compact list
 * styling and closes before dispatch; this component owns no workflow state. */
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

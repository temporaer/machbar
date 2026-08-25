import type { Tag } from "@machbar/shared";
import { strings } from "../lib/strings";

export function TagChip({
  tag,
  excluded,
  onRemove,
  onToggleExclude,
}: {
  tag: Tag;
  excluded?: boolean;
  onRemove?: () => void;
  onToggleExclude?: () => void;
}) {
  return (
    <span className={`chip${excluded ? " chip-muted" : ""}`}>
      {tag.name}
      {onToggleExclude ? (
        <button
          type="button"
          onClick={onToggleExclude}
          aria-label={excluded ? strings.includeInheritedTag : strings.excludeInheritedTag}
        >
          {excluded ? "↺" : "⊘"}
        </button>
      ) : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={strings.removeTag}>
          ×
        </button>
      ) : null}
    </span>
  );
}

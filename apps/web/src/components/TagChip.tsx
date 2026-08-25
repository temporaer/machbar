import type { CSSProperties } from "react";
import type { Tag } from "@machbar/shared";
import { strings } from "../lib/strings";

export function TagChip({
  tag,
  excluded,
  disabled,
  onRemove,
  onToggleExclude,
}: {
  tag: Tag;
  excluded?: boolean;
  disabled?: boolean;
  onRemove?: () => void;
  onToggleExclude?: () => void;
}) {
  return (
    <span
      className={`chip tag-chip${excluded ? " chip-muted" : ""}`}
      style={{ "--tag-color": tag.color } as CSSProperties}
    >
      {tag.name}
      {onToggleExclude ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleExclude}
          aria-label={excluded ? strings.includeInheritedTag : strings.excludeInheritedTag}
        >
          {excluded ? "↺" : "⊘"}
        </button>
      ) : null}
      {onRemove ? (
        <button type="button" disabled={disabled} onClick={onRemove} aria-label={strings.removeTag}>
          ×
        </button>
      ) : null}
    </span>
  );
}

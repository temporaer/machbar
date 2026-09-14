import { useStrings } from "../lib/strings";

export interface CaptionHintChoice {
  key: string;
  label: string;
  ariaLabel?: string;
}

export function CaptionHintSuggestions({
  hints,
  disabled = false,
  onSelect,
}: {
  hints: readonly CaptionHintChoice[];
  disabled?: boolean;
  onSelect: (key: string) => void;
}) {
  const strings = useStrings();
  if (hints.length === 0) return null;

  return (
    <div className="caption-hints">
      <span className="field-label">{strings.fromTitle}</span>
      <div className="choice-group">
        {hints.map((hint) => (
          <button
            key={hint.key}
            type="button"
            className="choice-chip caption-hint-chip"
            disabled={disabled}
            aria-label={hint.ariaLabel}
            onClick={() => onSelect(hint.key)}
          >
            {hint.label}
          </button>
        ))}
      </div>
    </div>
  );
}

import { strings } from "../lib/strings";
import {
  groupableTagKinds,
  type GroupableTagKind,
} from "../lib/tagGrouping";

export function TagGroupingControl({
  value,
  onChange,
}: {
  value: GroupableTagKind | null;
  onChange: (value: GroupableTagKind | null) => void;
}) {
  return (
    <div className="list-option-field">
      <span className="list-option-label">{strings.groupByTagType}</span>
      <div
        className="list-option-group"
        role="group"
        aria-label={strings.groupByTagType}
      >
        <button
          type="button"
          className="list-option-button"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          {strings.noGrouping}
        </button>
        {groupableTagKinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className="list-option-button"
            aria-pressed={value === kind}
            onClick={() => onChange(kind)}
          >
            {strings.tagKindLabels[kind]}
          </button>
        ))}
      </div>
    </div>
  );
}

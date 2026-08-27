import { useId, useRef, useState } from "react";
import { strings } from "../lib/strings";
import {
  groupableTagKinds,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { ListOptionDisclosureTrigger } from "./ListOptionDisclosure";

export function TagGroupingOptions({
  value,
  onChange,
  id,
  hidden = false,
}: {
  value: GroupableTagKind | null;
  onChange: (value: GroupableTagKind | null) => void;
  id?: string;
  hidden?: boolean;
}) {
  return (
    <div
      id={id}
      className="list-option-group"
      role="group"
      aria-label={strings.groupByTagType}
      hidden={hidden}
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
  );
}

export function TagGroupingControl({
  value,
  onChange,
}: {
  value: GroupableTagKind | null;
  onChange: (value: GroupableTagKind | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const optionsId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentValue = value ? strings.tagKindLabels[value] : strings.noGrouping;

  return (
    <div className="list-option-disclosure">
      <ListOptionDisclosureTrigger
        label={strings.grouping}
        value={currentValue}
        expanded={expanded}
        controls={optionsId}
        onClick={() => setExpanded((current) => !current)}
        buttonRef={triggerRef}
      />
      <div className="list-option-disclosure-panel" hidden={!expanded}>
        <TagGroupingOptions
          id={optionsId}
          value={value}
          hidden={!expanded}
          onChange={(nextValue) => {
            onChange(nextValue);
            setExpanded(false);
            triggerRef.current?.focus();
          }}
        />
      </div>
    </div>
  );
}

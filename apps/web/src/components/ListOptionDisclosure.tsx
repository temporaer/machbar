import type { Ref } from "react";

export function ListOptionDisclosureTrigger({
  label,
  value,
  expanded,
  controls,
  onClick,
  buttonRef,
}: {
  label: string;
  value: string;
  expanded: boolean;
  controls: string;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="list-option-disclosure-trigger"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      ref={buttonRef}
    >
      <span className="list-option-disclosure-label">{label}</span>
      <span className="list-option-disclosure-separator" aria-hidden="true">
        ·
      </span>
      <span className="list-option-disclosure-value">{value}</span>
      <span className="list-option-disclosure-chevron" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

import { useEffect, useRef, useState, type Ref } from "react";
import { formatExactLocalDate } from "../lib/relativeDate";
import { parseNaturalDate } from "../lib/naturalDate";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { IconActionButton } from "./IconActionButton";

export function HumanDateInput({
  id,
  value,
  onChange,
  disabled,
  autoFocus,
  inputRef,
  onValidityChange,
}: {
  id: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onValidityChange?: (valid: boolean) => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const normalizedValue = value ?? "";
  const [draft, setDraft] = useState(
    normalizedValue
      ? (formatExactLocalDate(normalizedValue, locale) ?? normalizedValue)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  useEffect(() => {
    setDraft(
      normalizedValue
        ? (formatExactLocalDate(normalizedValue, locale) ?? normalizedValue)
        : "",
    );
    setError(null);
    onValidityChange?.(true);
  }, [locale, normalizedValue, onValidityChange]);

  const commit = () => {
    const input = draft.trim();
    if (!input) {
      setDraft("");
      setError(null);
      onValidityChange?.(true);
      if (normalizedValue) onChange(null);
      return;
    }

    const parsed = parseNaturalDate(input, new Date(), locale);
    if (!parsed) {
      setError(strings.invalidDate);
      onValidityChange?.(false);
      return;
    }

    setDraft(formatExactLocalDate(parsed, locale) ?? parsed);
    setError(null);
    onValidityChange?.(true);
    if (parsed !== normalizedValue) onChange(parsed);
  };

  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker) return;
    if (typeof picker.showPicker === "function") {
      try {
        picker.showPicker();
        return;
      } catch {
        // Browsers may expose showPicker but deny it outside a trusted click.
      }
    }
    picker.click();
  };

  return (
    <div className="human-date-field">
      <div className={`human-date-control${error ? " human-date-control-invalid" : ""}`}>
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="text"
          value={draft}
          placeholder={strings.dateInputPlaceholder}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            if (error) setError(null);
            onValidityChange?.(
              nextDraft.trim().length === 0 ||
                parseNaturalDate(nextDraft, new Date(), locale) !== null,
            );
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <IconActionButton
          kind="schedule"
          label={strings.chooseDate}
          {...(disabled === undefined ? {} : { disabled })}
          onClick={openPicker}
        />
        <input
          ref={pickerRef}
          className="visually-hidden"
          type="date"
          value={normalizedValue}
          aria-hidden="true"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) => {
            const nextValue = event.target.value || null;
            setDraft(
              nextValue
                ? (formatExactLocalDate(nextValue, locale) ?? nextValue)
                : "",
            );
            setError(null);
            onValidityChange?.(true);
            onChange(nextValue);
          }}
        />
      </div>
      {error ? (
        <span id={errorId} className="human-date-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

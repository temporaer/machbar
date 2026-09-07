import type { Ref } from "react";
import { useStrings } from "../lib/strings";

/**
 * Shared row chrome for `TaskRow`/`ProjectStoryRow`: the swipe-background
 * pair, the kebab (chip-strip toggle) button, and the retained-error
 * banner. All three pieces were previously duplicated near-identically in
 * both row implementations, differing only in their CSS class prefix
 * (`task-row`/`story-row`) and a couple of row-specific text/behavior
 * details passed in as props. Gesture handling, primary-action rendering,
 * and the chip contents themselves remain row-specific and are not part of
 * this shared chrome.
 */

export function RowSwipeBackgrounds({
  classPrefix,
  primaryLabel,
  primaryVisible,
  primaryVariantClass,
  secondaryLabel,
  secondaryVisible,
  secondaryVariantClass,
  coachAnimate,
}: {
  classPrefix: string;
  primaryLabel: string;
  primaryVisible: boolean;
  primaryVariantClass: string;
  secondaryLabel: string;
  secondaryVisible: boolean;
  secondaryVariantClass: string;
  coachAnimate: boolean;
}) {
  return (
    <>
      <div
        className={`${classPrefix}-swipe-bg ${primaryVariantClass}${primaryVisible ? " visible" : ""}${coachAnimate ? " swipe-coach-primary" : ""}`}
        aria-hidden="true"
      >
        {primaryLabel}
      </div>
      <div
        className={`${classPrefix}-swipe-bg ${secondaryVariantClass}${secondaryVisible ? " visible" : ""}${coachAnimate ? " swipe-coach-secondary" : ""}`}
        aria-hidden="true"
      >
        {secondaryLabel}
      </div>
    </>
  );
}

export function RowKebabButton({
  classPrefix,
  open,
  disabled,
  onToggle,
  buttonRef,
}: {
  classPrefix: string;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const strings = useStrings();
  return (
    <button
      type="button"
      className={`${classPrefix}-kebab`}
      aria-label={strings.moreActions}
      aria-expanded={open}
      disabled={disabled}
      ref={buttonRef}
      onClick={onToggle}
    >
      ⋯
    </button>
  );
}

export function RowErrorBanner({
  classPrefix,
  headline,
  message,
  onClose,
}: {
  classPrefix: string;
  headline?: string;
  message: string;
  onClose: () => void;
}) {
  const strings = useStrings();
  return (
    <div className={`${classPrefix}-error`} role="alert">
      <span>{headline ?? strings.error}</span>
      <span className="text-muted">{message}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
        {strings.close}
      </button>
    </div>
  );
}

import { useStrings } from "../lib/strings";

export function SwipeCoachHint({
  primaryAction,
  onDismiss,
}: {
  primaryAction: string;
  onDismiss: () => void;
}) {
  const strings = useStrings();

  return (
    <div className="swipe-coach-hint">
      <span className="swipe-coach-cue" aria-hidden="true">↔</span>
      <span>{strings.swipeCoachHint(primaryAction)}</span>
      <button
        type="button"
        className="swipe-coach-dismiss"
        aria-label={strings.swipeCoachDismiss}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

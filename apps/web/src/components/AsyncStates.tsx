import { useStrings } from "../lib/strings";

export function LoadingState() {
  const strings = useStrings();
  return (
    <div className="loading-state" role="status">
      {strings.loading}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const strings = useStrings();
  return (
    <div className="error-state" role="alert">
      <p>{strings.error}</p>
      <p className="text-muted">{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          {strings.retry}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{message}</span>
    </div>
  );
}

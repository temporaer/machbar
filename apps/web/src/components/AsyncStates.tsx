import { strings } from "../lib/strings";

export function LoadingState() {
  return (
    <div className="loading-state" role="status">
      {strings.loading}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
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
  return <div className="empty-state">{message}</div>;
}

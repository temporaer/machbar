import { useStrings } from "../lib/strings";

export function LoadingState() {
  const strings = useStrings();
  return (
    <div className="loading-state" role="status">
      {strings.loading}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  title,
  guidance,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
  guidance?: string;
}) {
  const strings = useStrings();
  const resolvedTitle = title ?? strings.error;
  const showMessage = message.trim() !== resolvedTitle.trim();
  return (
    <div className="error-state" role="alert">
      <strong className="error-state-title">{resolvedTitle}</strong>
      {showMessage ? <p>{message}</p> : null}
      <p className="text-muted">{guidance ?? strings.errorRecoveryHint}</p>
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

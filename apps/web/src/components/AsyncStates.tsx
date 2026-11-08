import { useStrings } from "../lib/strings";
import type { AsyncState } from "../lib/useAsync";

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
  pending = false,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
  guidance?: string;
  pending?: boolean;
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
        <button type="button" className="btn" onClick={onRetry} disabled={pending}>
          {strings.retry}
        </button>
      ) : null}
    </div>
  );
}

export function ReadErrorState({
  resource,
  error,
  refreshError,
  loading,
  refreshing,
  reload,
}: Pick<AsyncState<unknown>, "error" | "refreshError" | "loading" | "refreshing" | "reload"> & {
  resource: string;
}) {
  const strings = useStrings();
  const message = error ?? refreshError;
  if (message === null) return null;
  return (
    <ErrorState
      title={error !== null ? strings.readLoadFailed(resource) : strings.readRefreshFailed(resource)}
      message={message}
      guidance={error !== null ? strings.errorRecoveryHint : strings.readRefreshRecoveryHint}
      onRetry={reload}
      pending={loading || refreshing}
    />
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

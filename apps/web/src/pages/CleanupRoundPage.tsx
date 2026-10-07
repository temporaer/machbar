import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CleanupRoundItemRecord, CleanupRoundRecord } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useAsync } from "../lib/useAsync";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import {
  cleanupAnswerSurface,
  cleanupDefaultAnswer,
  cleanupRoundPending,
  cleanupSurfaceAction,
  type CleanupMicroFlow,
  type CleanupSurfaceAction,
} from "../lib/cleanupRound";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { CleanupRoundActionSheet } from "../components/CleanupRoundActionSheet";

/**
 * Klärungsrunde: an advisory, Home Assistant-backed coaching pass over a few
 * sampled work items. The page never mutates items from AI output by itself:
 * "Hinten anstellen" is the review acknowledgement, text-shaped answers open
 * a focused `CleanupRoundActionSheet` that shows the exact change before the
 * user confirms it (one cleanup-round action endpoint applies the change and
 * hides the card atomically), and the remaining surfaces open an existing workflow
 * through `useWorkItemCommands()`.
 */
export function CleanupRoundPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <CleanupRoundReview id={id} /> : <CleanupRoundStart />;
}

function CleanupRoundStart() {
  const strings = useStrings();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createCleanupRound();
      navigate(`/more/cleanup-round/${encodeURIComponent(id)}`, { replace: true });
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
      setBusy(false);
    }
  };
  return (
    <div className="stack cleanup-round-page">
      <div className="page-header">
        <h1>{strings.cleanupRound}</h1>
      </div>
      <section className="card stack">
        <p>{strings.cleanupRoundDescription}</p>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            {strings.cleanupRoundStart}
          </button>
          <Link className="btn" to="/more">{strings.cleanupRoundClose}</Link>
        </div>
        {error ? <p className="text-muted" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}

function CleanupRoundReview({ id }: { id: string }) {
  const strings = useStrings();
  const navigate = useNavigate();
  const state = useAsync(() => api.getCleanupRound(id), [id]);
  const [record, setRecord] = useState<CleanupRoundRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = record ?? state.data;

  useEffect(() => {
    if (state.data) setRecord(null);
  }, [state.data]);
  useEffect(() => {
    if (!round || !cleanupRoundPending(round.status)) return;
    const timer = window.setInterval(state.reload, 2_000);
    return () => window.clearInterval(timer);
  }, [round?.status, state.reload]);

  const run = async (operation: () => Promise<CleanupRoundRecord | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      if (next) setRecord(next);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };
  const resolveItem = (itemId: string, resolution: "dismiss" | "mark-reviewed") =>
    run(() => api.resolveCleanupRoundItem(id, itemId, resolution));
  const close = () =>
    void run(async () => {
      if (round && !["dismissed", "completed"].includes(round.status)) {
        await api.dismissCleanupRound(id);
      }
      navigate("/more");
    });

  if (state.loading && !round) return <LoadingState />;
  if (!round) {
    return <ErrorState message={state.error ?? strings.cleanupRoundFailed} onRetry={state.reload} />;
  }

  const header = (
    <div className="page-header">
      <h1>{strings.cleanupRound}</h1>
    </div>
  );
  if (cleanupRoundPending(round.status)) {
    return (
      <div className="stack cleanup-round-page">
        {header}
        <section className="card stack" role="status">
          <p>{strings.cleanupRoundPending}</p>
          {!round.homeAssistant.workerOnline ? (
            <p className="text-muted">{strings.cleanupRoundWorkerOffline}</p>
          ) : null}
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={close}>
              {strings.cleanupRoundClose}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const retry = () => void run(() => api.retryCleanupRound(id));
  // Failed items stay visible: they are still open in this round.
  const openItems = round.items.filter((item) => item.status === "ready" || item.status === "failed");
  const orderedOpenItems = [...openItems].sort((left, right) =>
    cleanupCardSortRank(left) - cleanupCardSortRank(right));
  const failedItems = openItems.filter((item) => item.status === "failed");
  const hasFailed = failedItems.length > 0;
  // One retry control at a time: a lone failed card owns it, otherwise the banner.
  const cardRetry = failedItems.length === 1 && failedItems[0]!.exists;
  return (
    <div className="stack cleanup-round-page">
      {header}
      {round.summary ? <p className="text-muted">{round.summary}</p> : null}
      {round.status === "failed" || (round.status === "partial" && hasFailed) ? (
        <section className="card stack" role={round.status === "failed" ? "alert" : "status"}>
          <p>{round.status === "failed" ? strings.cleanupRoundFailed : strings.cleanupRoundPartial}</p>
          {hasFailed && !cardRetry ? (
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={retry}>
                {round.status === "failed" ? strings.cleanupRoundRetry : strings.cleanupRoundRetryMissing}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {error ? <p className="text-muted" role="alert">{error}</p> : null}
      {orderedOpenItems.length === 0 ? (
        <p className="text-muted">{strings.cleanupRoundDone}</p>
      ) : (
        <p className="text-muted cleanup-round-hint">{strings.cleanupRoundResolutionHint}</p>
      )}
      {orderedOpenItems.map((item) => (
        <CleanupRoundCard
          key={item.id}
          roundId={id}
          item={item}
          busy={busy}
          {...(cardRetry ? { onRetry: retry } : {})}
          onResolve={(resolution) => resolveItem(item.id, resolution)}
          onApplied={(next) => {
            setError(null);
            setRecord(next);
          }}
        />
      ))}
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={close}>
          {strings.cleanupRoundClose}
        </button>
      </div>
    </div>
  );
}

function cleanupCardSortRank(item: CleanupRoundItemRecord): number {
  if (item.status === "failed") return 1;
  if (item.result?.proposal === "leave_alone" || item.result?.resolutionSurface === "mark_reviewed") return 2;
  return 0;
}

function isNoActionCleanupItem(item: CleanupRoundItemRecord): boolean {
  return item.result?.proposal === "leave_alone" || item.result?.resolutionSurface === "mark_reviewed";
}

function CleanupRoundCard({
  roundId,
  item,
  busy,
  onRetry,
  onResolve,
  onApplied,
}: {
  roundId: string;
  item: CleanupRoundItemRecord;
  busy: boolean;
  /** Present only when this card owns the round's retry control. */
  onRetry?: (() => void) | undefined;
  onResolve: (resolution: "dismiss" | "mark-reviewed") => Promise<void>;
  /** Receives the round returned by a confirmed micro-flow action. */
  onApplied: (round: CleanupRoundRecord) => void;
}) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<CleanupMicroFlow | null>(null);
  const result = item.status === "ready" ? item.result : null;
  const noAction = isNoActionCleanupItem(item);
  const prefixes = {
    decision: strings.cleanupRoundDecisionPrefix,
    followup: strings.cleanupRoundFollowupPrefix,
    doneWhen: strings.cleanupRoundDoneWhenPrefix,
  };
  const [answer, setAnswer] = useState(() => (result ? cleanupDefaultAnswer(item, result, prefixes) : ""));
  const role = item.targetType === "project" ? "story" : "task";
  const statusLabel =
    item.targetType === "project"
      ? strings.projectStatusLabels[item.itemStatus as keyof typeof strings.projectStatusLabels]
      : strings.taskStatusLabels[item.itemStatus as keyof typeof strings.taskStatusLabels];
  const context = [
    item.targetType === "project" ? strings.cleanupRoundProjectTarget : strings.cleanupRoundTaskTarget,
    item.projectTitle,
    item.parentTitle,
    statusLabel ?? item.itemStatus,
  ].filter(Boolean).join(" · ");
  const surface = result?.resolutionSurface;
  const answerSurface = surface ? cleanupAnswerSurface(surface) : false;
  const action: CleanupSurfaceAction | null = result ? cleanupSurfaceAction(item, result, answer) : null;
  const actionLabel = action && action.kind !== "markReviewed" ? action.label : null;
  const suggestion = result && !answerSurface ? result.suggestedTitle ?? result.suggestedDefault : null;
  const answerId = `cleanup-answer-${item.id}`;

  const resolveSurface = async () => {
    if (!action) return;
    setError(null);
    try {
      if (action.kind === "markReviewed") {
        await onResolve("mark-reviewed");
      } else if (action.kind === "confirm") {
        setFlow(action.flow);
      } else if (action.kind === "command") {
        dispatch(action.command);
      } else {
        dispatch({ type: action.command, story: await api.getProject(action.projectId) });
      }
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <article className={`card stack cleanup-round-card${noAction ? " cleanup-round-card-muted" : ""}`} aria-label={item.title}>
      <div className="cleanup-round-card-heading">
        <strong>{item.title}</strong>
        <small className="text-muted">{context}</small>
      </div>
      {!item.exists ? (
        <p className="text-muted">{strings.cleanupRoundItemMissing}</p>
      ) : result ? (
        <>
          <span className="badge">{strings.cleanupProposalLabels[result.proposal]}</span>
          <p>{result.reason}</p>
          <p>
            <strong>{strings.cleanupRoundQuestion}:</strong> {result.question}
          </p>
          {answerSurface ? (
            <div className="field">
              <label htmlFor={answerId}>{strings.cleanupRoundAnswer}</label>
              <textarea
                id={answerId}
                rows={2}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <small className="text-muted">{strings.cleanupRoundAnswerHint}</small>
            </div>
          ) : suggestion ? (
            <p className="text-muted">
              {strings.cleanupRoundSuggestion}: {suggestion}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted">{strings.cleanupRoundItemFailed}</p>
      )}
      <div className="row cleanup-round-actions">
        {item.exists && result ? (
          <>
            {actionLabel ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void resolveSurface()}>
                {strings.cleanupActionLabels[actionLabel]}
              </button>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={() => void onResolve("mark-reviewed")}>
              {strings.cleanupRoundMarkReviewed}
            </button>
          </>
        ) : null}
        {item.exists && !result && onRetry ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}>
            {strings.cleanupRoundRetry}
          </button>
        ) : null}
        {item.exists ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => dispatch({ type: "workItem.open", workItem: { id: item.targetId, role } })}
          >
            {strings.cleanupRoundOpen}
          </button>
        ) : null}
        <button type="button" className="btn" disabled={busy} onClick={() => void onResolve("dismiss")}>
          {strings.cleanupRoundDismissItem}
        </button>
      </div>
      {error ? <p className="text-muted" role="alert">{error}</p> : null}
      {flow ? (
        <CleanupRoundActionSheet
          roundId={roundId}
          itemId={item.id}
          targetType={item.targetType}
          targetId={item.targetId}
          flow={flow}
          onClose={() => setFlow(null)}
          // The endpoint improved the item and hid the card in one transaction.
          onApplied={onApplied}
        />
      ) : null}
    </article>
  );
}

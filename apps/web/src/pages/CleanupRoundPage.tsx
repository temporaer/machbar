import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CleanupRoundItemRecord, CleanupRoundRecord } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useAsync } from "../lib/useAsync";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import {
  cleanupChildTitle,
  cleanupRoundPending,
  cleanupSurfaceAction,
} from "../lib/cleanupRound";
import { ErrorState, LoadingState } from "../components/AsyncStates";

/**
 * Klärungsrunde: an advisory, Home Assistant-backed coaching pass over a few
 * sampled work items. The page never mutates items from AI output; besides
 * "Hinten anstellen" (review acknowledgement) every action opens an existing
 * workflow through `useWorkItemCommands()`.
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

  const retry = (
    <button
      type="button"
      className="btn btn-primary"
      disabled={busy}
      onClick={() => void run(() => api.retryCleanupRound(id))}
    >
      {strings.cleanupRoundRetry}
    </button>
  );
  if (round.status === "failed") {
    return (
      <div className="stack cleanup-round-page">
        {header}
        <section className="card stack" role="alert">
          <p>{strings.cleanupRoundFailed}</p>
          {error ? <p className="text-muted">{error}</p> : null}
          <div className="row">
            {retry}
            <button type="button" className="btn" disabled={busy} onClick={close}>
              {strings.cleanupRoundClose}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const openItems = round.items.filter((item) => item.status === "ready");
  return (
    <div className="stack cleanup-round-page">
      {header}
      {round.summary ? <p className="text-muted">{round.summary}</p> : null}
      {round.status === "partial" ? (
        <section className="card stack" role="status">
          <p>{strings.cleanupRoundPartial}</p>
          <div className="row">{retry}</div>
        </section>
      ) : null}
      {error ? <p className="text-muted" role="alert">{error}</p> : null}
      {openItems.length === 0 ? <p className="text-muted">{strings.cleanupRoundDone}</p> : null}
      {openItems.map((item) => (
        <CleanupRoundCard
          key={item.id}
          item={item}
          busy={busy}
          onResolve={(resolution) =>
            void run(() => api.resolveCleanupRoundItem(id, item.id, resolution))
          }
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

function CleanupRoundCard({
  item,
  busy,
  onResolve,
}: {
  item: CleanupRoundItemRecord;
  busy: boolean;
  onResolve: (resolution: "dismiss" | "mark-reviewed") => void;
}) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();
  const [error, setError] = useState<string | null>(null);
  const result = item.result;
  const prefixes = {
    decision: strings.cleanupRoundDecisionPrefix,
    followup: strings.cleanupRoundFollowupPrefix,
  };
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
  const suggestion = result
    ? cleanupChildTitle(result, prefixes) ?? result.suggestedTitle ?? result.suggestedDefault
    : null;
  const surface = result?.resolutionSurface;
  const showSurface = surface && surface !== "mark_reviewed" && surface !== "open_item";

  const resolveSurface = async () => {
    if (!result) return;
    const action = cleanupSurfaceAction(item, result, prefixes);
    setError(null);
    try {
      if (action.kind === "markReviewed") {
        onResolve("mark-reviewed");
      } else if (action.kind === "command") {
        dispatch(action.command);
      } else {
        const story = await api.getProject(action.projectId);
        dispatch({ type: action.command, story });
      }
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    }
  };

  return (
    <article className="card stack cleanup-round-card" aria-label={item.title}>
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
          {suggestion ? (
            <p className="text-muted">
              {strings.cleanupRoundSuggestion}: {suggestion}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted">{strings.cleanupRoundNoResult}</p>
      )}
      <div className="row cleanup-round-actions">
        {item.exists ? (
          <>
            {showSurface ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void resolveSurface()}>
                {strings.cleanupSurfaceLabels[surface]}
              </button>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={() => onResolve("mark-reviewed")}>
              {strings.cleanupRoundMarkReviewed}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => dispatch({ type: "workItem.open", workItem: { id: item.targetId, role } })}
            >
              {strings.cleanupRoundOpen}
            </button>
          </>
        ) : null}
        <button type="button" className="btn" disabled={busy} onClick={() => onResolve("dismiss")}>
          {strings.cleanupRoundDismissItem}
        </button>
      </div>
      {error ? <p className="text-muted" role="alert">{error}</p> : null}
    </article>
  );
}

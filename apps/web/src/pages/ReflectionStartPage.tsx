import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ReflectionBriefing, ReflectionBriefingScope } from "@machbar/shared";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { NativeShareButton } from "../components/NativeShareButton";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { buildReflectionExportText, downloadReflectionExport } from "../lib/reflectionExport";
import { useStrings } from "../lib/strings";

type ReportingDays = 30 | 90 | 180;

export function ReflectionStartPage() {
  const strings = useStrings();
  const { currentMember, currentMemberId } = useIdentity();
  const [days, setDays] = useState<ReportingDays>(90);
  const [scope, setScope] = useState<ReflectionBriefingScope>("household");
  const [briefing, setBriefing] = useState<ReflectionBriefing | null>(null);
  const [briefingQueryKey, setBriefingQueryKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [privateShareConsentKey, setPrivateShareConsentKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const requestId = useRef(0);
  const queryKey = `${currentMemberId ?? "none"}:${days}:${scope}`;
  const requestKey = `${queryKey}:${retry}`;

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    setBriefing(null);
    setBriefingQueryKey(null);
    setLoading(true);
    setError(null);
    setStatus(null);
    if (currentMemberId === null) {
      setLoading(false);
      setError(strings.identityRequiredBody);
      return () => { cancelled = true; };
    }
    api.getReflectionBriefing(currentMemberId, days, scope)
      .then((result) => {
        if (!cancelled && id === requestId.current) {
          setBriefing(result);
          setBriefingQueryKey(requestKey);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled && id === requestId.current) setError(localizedErrorMessage(cause, strings));
      })
      .finally(() => {
        if (!cancelled && id === requestId.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentMemberId, days, scope, retry, strings, requestKey]);

  const coachingInstruction = strings.reflectionCoachPrompt;
  const exportText = useMemo(
    () => briefing ? buildReflectionExportText(briefing, coachingInstruction, {
      coaching: strings.reflectionPromptLabel,
      briefing: strings.reflectionBriefingLabel,
    }) : "",
    [briefing, coachingInstruction, strings.reflectionPromptLabel, strings.reflectionBriefingLabel],
  );
  const includesPrivateWork = scope !== "household";
  const briefingMatchesSelection = briefing !== null && briefingQueryKey === requestKey;
  const mayExport = briefingMatchesSelection && (!includesPrivateWork || privateShareConsentKey === requestKey);

  const copy = async () => {
    setStatus(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error(strings.clipboardUnavailable);
      await navigator.clipboard.writeText(exportText);
      setStatus(strings.reflectionCopied);
    } catch (cause) {
      setStatus(localizedErrorMessage(cause, strings));
    }
  };

  const download = (format: "markdown" | "text") => {
    setStatus(null);
    try {
      downloadReflectionExport(exportText, format);
      setStatus(format === "markdown" ? strings.reflectionMarkdownDownloaded : strings.reflectionTextDownloaded);
    } catch (cause) {
      setStatus(localizedErrorMessage(cause, strings));
    }
  };

  const loadError = error ? <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} /> : null;

  return (
    <div className="stack reflection-start-page">
      <div className="page-header">
        <h1>{strings.reflectionStart}</h1>
      </div>
      <p className="page-subtitle">{strings.reflectionStartHint}</p>

      <section className="card stack" aria-label={strings.reflectionSettings}>
        <fieldset className="reflection-choice-field">
          <legend>{strings.reflectionPeriod}</legend>
          <div className="choice-group" role="group" aria-label={strings.reflectionPeriod}>
            {([30, 90, 180] as const).map((value) => (
              <button key={value} type="button" className="choice-chip" aria-pressed={days === value}
                onClick={() => setDays(value)}>
                {strings.reflectionDays(value)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="reflection-choice-field">
          <legend>{strings.reflectionScope}</legend>
          <div className="choice-group reflection-scope-options" role="group" aria-label={strings.reflectionScope}>
            {([
              ["household", strings.reflectionScopeHousehold],
              ["work", strings.reflectionScopeWork],
              ["all", strings.reflectionScopeAll],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className="choice-chip" aria-pressed={scope === value}
                onClick={() => setScope(value)}>
                {label}
              </button>
            ))}
          </div>
          {includesPrivateWork ? (
            <p className="text-muted reflection-privacy-note">{strings.reflectionPrivateScopeHint}</p>
          ) : (
            <p className="text-muted reflection-privacy-note">{strings.reflectionHouseholdScopeHint}</p>
          )}
        </fieldset>
      </section>

      {loading || (!error && !briefingMatchesSelection) ? <LoadingState /> : null}
      {!loading && error ? loadError : null}

      {!loading && briefingMatchesSelection && briefing ? (
        <>
          {includesPrivateWork ? (
            <label className="card reflection-private-confirm">
              <input type="checkbox" checked={privateShareConsentKey === requestKey}
                onChange={(event) => setPrivateShareConsentKey(event.target.checked ? requestKey : null)} />
              <span>{strings.reflectionPrivateShareConsent}</span>
            </label>
          ) : null}

          <section className="card stack" aria-labelledby="reflection-preview-heading">
            <div>
              <h2 id="reflection-preview-heading">{strings.reflectionPreviewTitle}</h2>
              <p className="text-muted">{strings.reflectionPreviewHint}</p>
            </div>
            <div className="reflection-prompt-preview">
              <h3>{strings.reflectionPromptLabel}</h3>
              <p>{coachingInstruction}</p>
            </div>
            <div className="reflection-briefing-preview">
              <h3>{strings.reflectionBriefingLabel}</h3>
              <p className="text-muted">{strings.reflectionPreviewScope(briefing.window.startDate, briefing.window.endDate, currentMember?.name ?? briefing.subject.name)}</p>
              <textarea aria-label={strings.reflectionSharedContent} readOnly value={exportText} rows={14} />
            </div>
            <div className="reflection-export-actions" aria-label={strings.reflectionExportActions}>
              <NativeShareButton title={strings.reflectionShareTitle} text={exportText} disabled={!mayExport} />
              <button type="button" className="btn" disabled={!mayExport} onClick={() => void copy()}>{strings.reflectionCopy}</button>
              <button type="button" className="btn" disabled={!mayExport} onClick={() => download("markdown")}>{strings.reflectionDownloadMarkdown}</button>
              <button type="button" className="btn" disabled={!mayExport} onClick={() => download("text")}>{strings.reflectionDownloadText}</button>
            </div>
            {!mayExport ? <p className="text-muted" role="status">{strings.reflectionPrivateShareRequired}</p> : null}
            {status ? <p className="text-muted" role="status">{status}</p> : null}
            <p className="text-muted">{strings.reflectionNoAutomaticSend}</p>
          </section>
        </>
      ) : null}
      <div className="row">
        <Link className="btn" to="/more">{strings.back}</Link>
      </div>
    </div>
  );
}

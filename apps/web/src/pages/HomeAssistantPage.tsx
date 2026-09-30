import { useState } from "react";
import type {
  HomeAssistantContextSnapshot,
  HomeAssistantPairingCode,
} from "@machbar/shared";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { PageHeader } from "../components/PageHeader";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { HomeAssistantPersonLocation } from "../components/HomeAssistantPersonLocation";

type AiTaskState = HomeAssistantContextSnapshot["intake"]["aiTask"]["state"];
type CalendarState = HomeAssistantContextSnapshot["intake"]["calendar"]["state"];

function aiTaskStateMessage(
  state: AiTaskState,
  strings: ReturnType<typeof useStrings>,
): string {
  switch (state) {
    case "ok":
      return strings.intakeAiTaskOk;
    case "not_configured":
      return strings.intakeAiTaskNotConfigured;
    case "missing":
      return strings.intakeAiTaskMissing;
    case "no_generate_data":
      return strings.intakeAiTaskNoGenerateData;
  }
}

function calendarStateMessage(
  state: CalendarState,
  strings: ReturnType<typeof useStrings>,
): string {
  switch (state) {
    case "ok":
      return strings.intakeCalendarOk;
    case "not_configured":
      return strings.intakeCalendarNotConfigured;
    case "missing":
      return strings.intakeCalendarMissing;
    case "not_writable":
      return strings.intakeCalendarNotWritable;
  }
}

export function HomeAssistantPage() {
  const strings = useStrings();
  const { members } = useIdentity();
  const { data: status, loading, error, reload } = useAsync(
    () => api.getHomeAssistantStatus(),
    [],
  );
  const [pairing, setPairing] = useState<HomeAssistantPairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="more-page">
      <PageHeader title={strings.homeAssistant} />
      <Link to="/more" className="btn btn-ghost">
        {strings.back}
      </Link>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {status ? (
        <div className="stack">
          <section className="card more-setting-card">
            <h2>{strings.intakeCapabilities}</h2>
            <p>
              <strong>
                {status.intakeReady
                  ? strings.intakeReadyStatus
                  : strings.intakeNotReadyStatus}
              </strong>
            </p>
            {status.protocolOutdated ? <p role="alert">{strings.intakeProtocolOutdated}</p> : null}
            <p>{status.workerOnline ? strings.intakeWorkerOnline : strings.intakeWorkerOffline}</p>
            {status.lastRequestPollAt ? <p>{strings.homeAssistantLastUpdate}: {new Date(status.lastRequestPollAt).toLocaleString()}</p> : null}
            {status.intake ? (
              <div className="stack">
                <p>
                  <strong>{strings.intakeAiTask}:</strong>{" "}
                  {status.intake.aiTask.entityId ?? strings.intakeEntityNotConfigured}
                  {" — "}
                  {aiTaskStateMessage(status.intake.aiTask.state, strings)}
                </p>
                <p>
                  {status.intake.aiTask.supportsAttachments
                    ? strings.intakeAttachmentsSupported
                    : strings.intakeAttachmentsUnsupported}
                </p>
                <p>
                  <strong>{strings.intakeCalendarEntity}:</strong>{" "}
                  {status.intake.calendar.entityId ?? strings.intakeEntityNotConfigured}
                  {" — "}
                  {calendarStateMessage(status.intake.calendar.state, strings)}
                </p>
              </div>
            ) : null}
          </section>

          <section className="card more-setting-card">
            <h2>{strings.homeAssistantConnection}</h2>
            <p className="text-muted">
              {status.connected
                ? status.stale
                  ? strings.homeAssistantStale
                  : strings.homeAssistantConnected
                : strings.homeAssistantDisconnected}
            </p>
            {status.lastUpdateAt ? (
              <p>
                {strings.homeAssistantLastUpdate}:{" "}
                {new Date(status.lastUpdateAt).toLocaleString()}
              </p>
            ) : null}
            {status.protocolVersion ? (
              <p>{`${strings.homeAssistantProtocol}: ${status.protocolVersion}`}</p>
            ) : null}
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPairing(await api.createHomeAssistantPairingCode());
                  })
                }
              >
                {status.connected
                  ? strings.homeAssistantReconnect
                  : strings.homeAssistantPair}
              </button>
              {status.connected ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.revokeHomeAssistant();
                      setPairing(null);
                    })
                  }
                >
                  {strings.homeAssistantDisconnect}
                </button>
              ) : null}
            </div>
            {pairing ? (
              <div className="stack" role="status">
                <strong className="pairing-code">{pairing.code}</strong>
                <p className="text-muted">{strings.homeAssistantPairingHint}</p>
              </div>
            ) : null}
          </section>

          <section className="card more-setting-card">
            <h2>{strings.physicalContexts}</h2>
            {status.contexts.length > 0 ? (
              <ul>
                {status.contexts.map((context) => (
                  <li key={context.id}>
                    {context.name}
                    {!context.active ? ` (${strings.inactive})` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">{strings.noPhysicalContexts}</p>
            )}
          </section>

          <section className="card more-setting-card">
            <h2>{strings.homeAssistantPeople}</h2>
            <p className="text-muted">{strings.homeAssistantPeopleHint}</p>
            {status.people.map((person) => (
              <label key={person.externalId} className="field home-assistant-person">
                <span className="home-assistant-person-heading">
                  <strong>{person.name}</strong>
                  <HomeAssistantPersonLocation
                    person={person}
                    stale={status.stale}
                    showObservedAt
                  />
                </span>
                <select
                  value={person.mappedMemberId ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const memberId = event.target.value
                      ? Number(event.target.value)
                      : null;
                    void run(() =>
                      api.setHomeAssistantMemberMapping(
                        person.externalId,
                        memberId,
                      ),
                    );
                  }}
                >
                  <option value="">{strings.homeAssistantUnmapped}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </section>
        </div>
      ) : null}
    </div>
  );
}

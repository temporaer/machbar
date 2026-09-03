import { useState } from "react";
import type { HomeAssistantPairingCode } from "@machbar/shared";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { PageHeader } from "../components/PageHeader";
import { LoadingState, ErrorState } from "../components/AsyncStates";

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
              <label key={person.externalId} className="field">
                <span>{person.name}</span>
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

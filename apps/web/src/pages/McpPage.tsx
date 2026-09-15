import { useMemo, useState } from "react";
import type { McpAgentToken, WorkItemScope } from "@machbar/shared";
import { Link } from "react-router-dom";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";

export function McpPage() {
  const strings = useStrings();
  const { data: agents, loading, error, reload } = useAsync(
    () => api.listMcpAgents(),
    [],
  );
  const [name, setName] = useState("Copilot");
  const [scope, setScope] = useState<WorkItemScope>("work");
  const [created, setCreated] = useState<McpAgentToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const endpoint = useMemo(
    () =>
      created
        ? new URL(created.endpoint, window.location.origin).toString()
        : "",
    [created],
  );

  const run = async (action: () => Promise<void>) => {
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
      <PageHeader title={strings.mcp} />
      <Link to="/more" className="btn btn-ghost">
        {strings.back}
      </Link>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <div className="stack">
        <section className="card more-setting-card">
          <h2>{strings.mcpCreateAgent}</h2>
          <p className="text-muted">{strings.mcpCreateHint}</p>
          <label className="field">
            <span>{strings.mcpAgentName}</span>
            <input
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{strings.mcpScope}</span>
            <select
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as WorkItemScope)
              }
            >
              <option value="work">{strings.mcpScopeWork}</option>
              <option value="household">{strings.mcpScopeHousehold}</option>
            </select>
          </label>
          <p className="text-muted">
            {scope === "work"
              ? strings.mcpScopeWorkHint
              : strings.mcpScopeHouseholdHint}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || name.trim() === ""}
            onClick={() =>
              void run(async () => {
                setCreated(await api.createMcpAgent(name, scope));
              })
            }
          >
            {strings.mcpCreate}
          </button>

          {created ? (
            <div className="stack" role="status">
              <strong>{strings.mcpTokenOnce}</strong>
              <label className="field">
                <span>{strings.mcpEndpoint}</span>
                <input readOnly value={endpoint} />
              </label>
              <label className="field">
                <span>{strings.mcpToken}</span>
                <textarea readOnly rows={3} value={created.token} />
              </label>
              <p className="text-muted">{strings.mcpConfigureHint}</p>
            </div>
          ) : null}
        </section>

        <section className="card more-setting-card">
          <h2>{strings.mcpAgents}</h2>
          {agents?.length ? (
            <ul className="stack">
              {agents.map((agent) => (
                <li key={agent.id} className="row-between">
                  <span>
                    <strong>{agent.name}</strong>
                    <small className="list-link-description">
                      {agent.scope === "work"
                        ? strings.mcpScopeWork
                        : strings.mcpScopeHousehold}
                      {agent.revokedAt ? ` · ${strings.mcpRevoked}` : ""}
                    </small>
                  </span>
                  {!agent.revokedAt ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.revokeMcpAgent(agent.id);
                          if (created?.agent.id === agent.id) setCreated(null);
                        })
                      }
                    >
                      {strings.mcpRevoke}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{strings.mcpNoAgents}</p>
          )}
        </section>
      </div>
    </div>
  );
}

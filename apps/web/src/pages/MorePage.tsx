import { Link } from "react-router-dom";
import { strings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useSwipeSettings, primarySwipeActions } from "../lib/swipeSettings";
import { IdentitySelector } from "../components/IdentitySelector";
import { MemberManager } from "../components/MemberManager";
import { fallbackColor, initials } from "../lib/format";
import { useState } from "react";

export function MorePage() {
  const { currentMember, authEnabled, logout } = useIdentity();
  const { primarySwipeAction, setPrimarySwipeAction } = useSwipeSettings();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  return (
    <div>
      <div className="page-header">
        <h1>{strings.moreTitle}</h1>
      </div>
      <div className="stack">
        <Link to="/mehr/suche" className="card list-link">
          <span className="row-between">
            <span>{strings.search}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/mehr/festgefahren" className="card list-link">
          <span className="row-between">
            <span>{strings.stuckProjects}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/mehr/backlog" className="card list-link">
          <span className="row-between">
            <span>{strings.backlogReview}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/mehr/refinement" className="card list-link">
          <span className="row-between">
            <span>{strings.refinement}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/mehr/aktivitaeten" className="card list-link">
          <span className="row-between">
            <span>
              <strong>Aktivitäten</strong>
              <small className="list-link-description">Änderungen an Aufgaben und Projekten</small>
            </span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>

        <div className="card">
          <h3 style={{ margin: 0 }}>{strings.swipeSettingTitle}</h3>
          <p className="text-muted">{strings.swipeSettingHint}</p>
          <div className="field">
            <label htmlFor="primary-swipe-action">{strings.swipeSettingTitle}</label>
            <select
              id="primary-swipe-action"
              value={primarySwipeAction}
              onChange={(e) => setPrimarySwipeAction(e.target.value as (typeof primarySwipeActions)[number])}
            >
              {primarySwipeActions.map((action) => (
                <option key={action} value={action}>
                  {strings.primarySwipeActionLabels[action]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>{strings.identity}</h3>
            {currentMember ? (
              <span className="row">
                <span
                  className="avatar"
                  style={{
                    width: 28,
                    height: 28,
                    fontSize: "0.7rem",
                    background: currentMember.color || fallbackColor(currentMember.id),
                  }}
                >
                  {initials(currentMember.name)}
                </span>
                <span>{currentMember.name}</span>
              </span>
            ) : null}
          </div>
          {authEnabled ? (
            <>
              <p className="text-muted">{strings.identityManagedByPocketId}</p>
              <button
                type="button"
                className="btn"
                disabled={loggingOut}
                onClick={() => {
                  setLoggingOut(true);
                  setLogoutError(null);
                  void logout()
                    .catch((cause: unknown) =>
                      setLogoutError(
                        cause instanceof Error ? cause.message : strings.error,
                      ),
                    )
                    .finally(() => setLoggingOut(false));
                }}
              >
                {strings.logout}
              </button>
              {logoutError ? (
                <p className="text-muted" role="alert">{logoutError}</p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-muted">{strings.switchIdentity}</p>
              <IdentitySelector />
            </>
          )}
        </div>

        <div className="card">
          <h3 style={{ margin: 0 }}>{strings.manageMembers}</h3>
          <p className="text-muted">{strings.manageMembersHint}</p>
          <MemberManager />
        </div>

        <Link to="/mehr/tags" className="card list-link">
          <span className="row-between">
            <span>
              <strong>{strings.manageTags}</strong>
              <small className="list-link-description">{strings.manageTagsHint}</small>
            </span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>

        <div className="card">
          <h3 style={{ margin: 0 }}>{strings.about}</h3>
          <p className="text-muted">{strings.tagline}</p>
          <p className="text-muted">
            {strings.version} 0.1.0
          </p>
        </div>
      </div>
    </div>
  );
}

import { Link } from "react-router-dom";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useSwipeSettings, primarySwipeActions } from "../lib/swipeSettings";
import { IdentitySelector } from "../components/IdentitySelector";
import { MemberManager } from "../components/MemberManager";
import { useState } from "react";
import { MemberAvatar } from "../components/MemberAvatar";
import { supportedLocales, useLocale } from "../lib/locale";
import { localizedErrorMessage } from "../lib/errorMessage";
import { themePreferences, useTheme } from "../lib/theme";
import { ContributionCard } from "../components/ContributionCard";

export function MorePage() {
  const strings = useStrings();
  const { locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
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
        <ContributionCard />
        <Link to="/more/search" className="card list-link">
          <span className="row-between">
            <span>{strings.search}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/more/stuck" className="card list-link">
          <span className="row-between">
            <span>{strings.stuckProjects}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/more/backlog" className="card list-link">
          <span className="row-between">
            <span>{strings.backlogReview}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/more/refinement" className="card list-link">
          <span className="row-between">
            <span>{strings.refinement}</span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>
        <Link to="/more/activity" className="card list-link">
          <span className="row-between">
            <span>
              <strong>{strings.activities}</strong>
              <small className="list-link-description">
                {strings.activitiesDescription}
              </small>
            </span>
            <span aria-hidden="true">›</span>
          </span>
        </Link>

        <div className="card">
          <h3 style={{ margin: 0 }}>{strings.appearance}</h3>
          <p className="text-muted">{strings.appearanceHint}</p>
          <div
            className="choice-group"
            role="group"
            aria-label={strings.theme}
          >
            {themePreferences.map((value) => (
              <button
                key={value}
                type="button"
                className="choice-chip"
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {strings.themeLabels[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 style={{ margin: 0 }}>{strings.language}</h3>
          <p className="text-muted">{strings.languageHint}</p>
          <div
            className="choice-group"
            role="group"
            aria-label={strings.language}
          >
            {supportedLocales.map((value) => (
              <button
                key={value}
                type="button"
                className="choice-chip"
                aria-pressed={locale === value}
                onClick={() => setLocale(value)}
              >
                {strings.localeLabels[value]}
              </button>
            ))}
          </div>
        </div>

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
                <MemberAvatar member={currentMember} size="sm" />
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
                      setLogoutError(localizedErrorMessage(cause, strings)),
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

        <Link to="/more/tags" className="card list-link">
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

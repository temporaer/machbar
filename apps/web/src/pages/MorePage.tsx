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
import { PushNotificationSettings } from "../components/PushNotificationSettings";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useDeveloperMode } from "../lib/developerMode";

export function MorePage() {
  const strings = useStrings();
  const { locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  const { currentMember, authEnabled, logout } = useIdentity();
  const { primarySwipeAction, setPrimarySwipeAction } = useSwipeSettings();
  const { developerMode, setDeveloperMode } = useDeveloperMode();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const { data: counts } = useAsync(() => api.getMoreCounts(), []);

  return (
    <div className="more-page">
      <div className="page-header">
        <h1>{strings.moreTitle}</h1>
      </div>

      <section className="more-section" aria-labelledby="more-momentum-heading">
        <h2 id="more-momentum-heading">{strings.moreMomentum}</h2>
        <ContributionCard />
      </section>

      <section className="more-section" aria-labelledby="more-review-heading">
        <h2 id="more-review-heading">{strings.moreFindAndReview}</h2>
        <div className="more-link-group">
          <Link to="/more/search" className="list-link more-list-link">
            <span>{strings.search}</span>
            <span aria-hidden="true">›</span>
          </Link>
          <Link to="/more/stuck" className="list-link more-list-link">
            <span>{strings.stuckProjects}</span>
            <span className="more-link-trailing">
              {counts ? (
                <span className="badge more-count-badge">{counts.stuckProjects}</span>
              ) : null}
              <span aria-hidden="true">›</span>
            </span>
          </Link>
          <Link to="/more/backlog" className="list-link more-list-link">
            <span>{strings.backlogReview}</span>
            <span className="more-link-trailing">
              {counts ? (
                <span className="badge more-count-badge">{counts.backlogReview}</span>
              ) : null}
              <span aria-hidden="true">›</span>
            </span>
          </Link>
          <Link to="/more/refinement" className="list-link more-list-link">
            <span>{strings.refinement}</span>
            <span className="more-link-trailing">
              {counts ? (
                <span className="badge more-count-badge">{counts.refinement}</span>
              ) : null}
              <span aria-hidden="true">›</span>
            </span>
          </Link>
          <Link to="/more/activity" className="list-link more-list-link">
            <span>
              <strong>{strings.activities}</strong>
              <small className="list-link-description">
                {strings.activitiesDescription}
              </small>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        </div>
      </section>

      <section className="more-section" aria-labelledby="more-preferences-heading">
        <h2 id="more-preferences-heading">{strings.morePreferences}</h2>
        <div className="stack">
          <div className="card more-setting-card">
            <h3>{strings.appearance}</h3>
            <p className="text-muted">{strings.appearanceHint}</p>
            <div className="choice-group" role="group" aria-label={strings.theme}>
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

          <PushNotificationSettings />

          <div className="card more-setting-card">
            <h3>{strings.language}</h3>
            <p className="text-muted">{strings.languageHint}</p>
            <div className="choice-group" role="group" aria-label={strings.language}>
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

          <div className="card more-setting-card">
            <h3>{strings.swipeSettingTitle}</h3>
            <p className="text-muted">{strings.swipeSettingHint}</p>
            <div className="field">
              <label htmlFor="primary-swipe-action">{strings.swipeSettingTitle}</label>
              <select
                id="primary-swipe-action"
                value={primarySwipeAction}
                onChange={(event) =>
                  setPrimarySwipeAction(
                    event.target.value as (typeof primarySwipeActions)[number],
                  )
                }
              >
                {primarySwipeActions.map((action) => (
                  <option key={action} value={action}>
                    {strings.primarySwipeActionLabels[action]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="more-section" aria-labelledby="more-household-heading">
        <h2 id="more-household-heading">{strings.moreHousehold}</h2>
        <div className="stack">
          <div className="card more-setting-card">
            <div className="row-between">
              <h3>{strings.identity}</h3>
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

          <div className="card more-setting-card">
            <h3>{strings.manageMembers}</h3>
            <p className="text-muted">{strings.manageMembersHint}</p>
            <MemberManager />
          </div>

          <div className="more-link-group">
            <Link to="/more/tags" className="list-link more-list-link">
              <span>
                <strong>{strings.manageTags}</strong>
                <small className="list-link-description">{strings.manageTagsHint}</small>
              </span>
              <span aria-hidden="true">›</span>
            </Link>
          </div>
        </div>
      </section>

      <section className="more-section" aria-labelledby="more-system-heading">
        <h2 id="more-system-heading">{strings.moreSystem}</h2>
        <div className="stack">
          <div className="card more-setting-card">
            <h3>{strings.about}</h3>
            <p className="text-muted">{strings.tagline}</p>
            <p className="text-muted">
              {strings.version} 0.1.0
            </p>
          </div>

          <div className="card more-setting-card">
            <label className="setting-switch">
              <span>
                <strong>{strings.developerMode}</strong>
                <small>{strings.developerModeHint}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={developerMode}
                onChange={(event) => setDeveloperMode(event.target.checked)}
              />
            </label>
          </div>

          {developerMode ? (
            <div className="more-link-group">
              <Link to="/more/debug" className="list-link more-list-link debug-settings-link">
                <span>
                  <strong>{strings.debugTitle}</strong>
                  <small className="list-link-description">{strings.debugLinkHint}</small>
                </span>
                <span aria-hidden="true">›</span>
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

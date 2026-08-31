import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { MemberAvatar } from "./MemberAvatar";

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function ContributionCard() {
  const strings = useStrings();
  const { data, loading, error, reload } = useAsync(
    () => api.getContributionSummary(),
    [],
  );

  return (
    <section className="card contribution-card" aria-labelledby="contribution-title">
      <div className="row-between contribution-heading">
        <div>
          <h3 id="contribution-title">{strings.contributionTitle}</h3>
          <p className="text-muted">{strings.contributionWindow}</p>
        </div>
        <strong
          className={`contribution-total${
            (data?.sharedTotal ?? 0) < 0 ? " contribution-negative" : ""
          }`}
        >
          {signed(data?.sharedTotal ?? 0)}
          <span>{strings.contributionPointsShort}</span>
        </strong>
      </div>

      {loading && data === null ? (
        <p className="text-muted contribution-state">{strings.loading}</p>
      ) : null}
      {error && data === null ? (
        <p className="contribution-state" role="alert">
          {strings.contributionLoadError}{" "}
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            {strings.retry}
          </button>
        </p>
      ) : null}
      {data ? (
        <>
          <div className="contribution-categories" aria-label={strings.contributionBreakdown}>
            <span>{strings.contributionCompletion}: <strong>{signed(data.sharedCategories.completion)}</strong></span>
            <span>{strings.contributionPlanning}: <strong>{signed(data.sharedCategories.planning)}</strong></span>
          </div>
          <details className="contribution-details">
            <summary className="disclosure-summary">
              {strings.contributionPeopleTitle}
            </summary>
            <div className="contribution-members">
              {data.members.map(({ member, total, categories }) => (
                <div className="contribution-member" key={member.id}>
                  <span className="row">
                    <MemberAvatar member={member} size="sm" />
                    <span>{member.name}</span>
                  </span>
                  <span className="contribution-member-score">
                    <strong>{signed(total)}</strong>
                    <small>
                      {signed(categories.completion)} {strings.contributionCompletionShort}
                      {" · "}
                      {signed(categories.planning)} {strings.contributionPlanningShort}
                    </small>
                  </span>
                </div>
              ))}
              {data.sharedOnlyTotal !== 0 ? (
                <div className="contribution-member contribution-shared-only">
                  <span>{strings.contributionSharedOnly}</span>
                  <strong>{signed(data.sharedOnlyTotal)}</strong>
                </div>
              ) : null}
            </div>
          </details>
          <details className="contribution-rules">
            <summary className="disclosure-summary">
              {strings.contributionRulesTitle}
            </summary>
            <p>{strings.contributionRulesBody}</p>
          </details>
        </>
      ) : null}
    </section>
  );
}

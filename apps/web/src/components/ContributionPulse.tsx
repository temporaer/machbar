import type { ContributionPulseLevel } from "@machbar/shared";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";

const EMPTY_PULSE: ContributionPulseLevel[] = Array.from(
  { length: 7 },
  () => "none",
);

export function ContributionPulse() {
  const strings = useStrings();
  const { data, error, reload } = useAsync(
    () => api.getContributionSummary(),
    [],
  );
  const levels = data?.pulse.map((bucket) => bucket.level) ?? EMPTY_PULSE;
  const levelLabels: Record<ContributionPulseLevel, string> = {
    none: strings.contributionPulseLevelNone,
    low: strings.contributionPulseLevelLow,
    medium: strings.contributionPulseLevelMedium,
    high: strings.contributionPulseLevelHigh,
  };
  const ariaLabel = `${strings.contributionPulseAria} ${strings.contributionPulseLevelsPrefix}: ${levels
    .map((level) => levelLabels[level])
    .join(", ")}.`;

  return (
    <div className="contribution-pulse-shell">
      <Link
        to="/more"
        className="contribution-pulse"
        aria-label={ariaLabel}
      >
        <span className="contribution-pulse-label">
          {strings.contributionPulseLabel}
        </span>
        <span className="contribution-pulse-segments" aria-hidden="true">
          {levels.map((level, index) => (
            <span
              key={index}
              className={`contribution-pulse-segment contribution-pulse-${level}`}
            />
          ))}
        </span>
        <span className="contribution-pulse-arrow" aria-hidden="true">›</span>
      </Link>
      {error ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost contribution-pulse-retry"
          onClick={reload}
        >
          {strings.contributionPulseRetry}
        </button>
      ) : null}
    </div>
  );
}

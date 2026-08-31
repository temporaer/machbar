import type { ContributionPulseLevel } from "@machbar/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";

const EMPTY_PULSE: ContributionPulseLevel[] = Array.from(
  { length: 7 },
  () => "none",
);

function localCalendarDate(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function ContributionPulse() {
  const strings = useStrings();
  const [calendarDay, setCalendarDay] = useState(localCalendarDate);
  const { data, error, reload } = useAsync(
    () => api.getContributionSummary(),
    [calendarDay],
  );
  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const timeout = window.setTimeout(
      () => setCalendarDay(localCalendarDate()),
      nextMidnight.getTime() - now.getTime() + 100,
    );
    return () => window.clearTimeout(timeout);
  }, [calendarDay]);
  useEffect(() => {
    const refreshAfterSleep = () => {
      if (document.visibilityState === "visible") {
        setCalendarDay(localCalendarDate());
      }
    };
    document.addEventListener("visibilitychange", refreshAfterSleep);
    return () =>
      document.removeEventListener("visibilitychange", refreshAfterSleep);
  }, []);
  const levels = data?.pulse.map((bucket) => bucket.level) ?? EMPTY_PULSE;
  const levelLabels: Record<ContributionPulseLevel, string> = {
    negative: strings.contributionPulseLevelNegative,
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

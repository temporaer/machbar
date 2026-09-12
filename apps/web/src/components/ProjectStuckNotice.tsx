import type { StuckReason } from "@machbar/shared";
import { useStrings } from "../lib/strings";

/**
 * `completion_review` is deliberately not presented as "stuck" -- an active
 * project with zero open tasks is healthy and ready for a completion
 * decision, not blocked. Every other reason keeps the genuine-blocker
 * heading/badge; only this one reason gets the distinct review framing.
 */
export function ProjectStuckNotice({ reason }: { reason: StuckReason }) {
  const strings = useStrings();
  const isReviewReady = reason === "completion_review";
  return (
    <section
      className={isReviewReady ? "project-review-panel" : "project-stuck-panel"}
      aria-labelledby="project-stuck-heading"
    >
      <div>
        <h2 id="project-stuck-heading">
          {isReviewReady ? strings.readyToCompleteHeading : strings.stuckProjectHeading}
        </h2>
        <span className={`badge ${isReviewReady ? "badge-review" : "badge-stuck"}`}>
          {strings.stuckReasonLabels[reason]}
        </span>
      </div>
      <p>{strings.stuckRepairLabels[reason]}</p>
    </section>
  );
}

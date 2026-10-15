import { Link } from "react-router-dom";
import type { AgendaInterventionFocus } from "@machbar/shared";
import { useStrings } from "../lib/strings";

/**
 * The Heute standing-focus strip for goal experiments (feature spec §6). It is
 * a sibling section of the agenda, never a task candidate: running experiments
 * show their one-line commitment and period progress, and a finished but
 * unreviewed experiment shows a single review call-to-action that stays in
 * Heute only inside the 7-day review window (`withinReviewWindow`, computed by
 * Phase 1). Interventions never enter task selection or the Review queue.
 */
export function InterventionFocusStrip({ focus }: { focus: AgendaInterventionFocus }) {
  const strings = useStrings();
  if (focus.running.length === 0 && focus.review.length === 0) {
    return null;
  }

  return (
    <div className="section intervention-focus" data-testid="intervention-focus">
      {focus.running.length > 0 ? (
        <>
          <div className="section-title">{strings.todayInterventionFocusTitle}</div>
          <ul className="stack intervention-focus-running">
            {focus.running.map((item) => (
              <li
                key={item.interventionId}
                className="card intervention-focus-card"
                data-testid="intervention-focus-running"
              >
                <strong>{item.goalTitle}</strong>
                <p>{item.commitment}</p>
                <p className="text-muted">
                  {strings.interventionPeriodProgress(item.periodDay, item.periodLength)}
                </p>
                {item.backing ? (
                  <p
                    className="text-muted intervention-focus-backing"
                    data-testid="intervention-focus-backing"
                  >
                    {strings.interventionBackingTally(
                      item.backing.hits,
                      item.backing.misses,
                    )}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {focus.review.length > 0 ? (
        <>
          <div className="section-title">{strings.todayInterventionReviewTitle}</div>
          <ul className="stack intervention-focus-review">
            {focus.review.map((item) => (
              <li
                key={item.interventionId}
                className="card intervention-focus-card"
                data-testid="intervention-focus-review"
              >
                <strong>{item.goalTitle}</strong>
                <p>{item.commitment}</p>
                <Link className="btn btn-sm btn-primary" to="/more/goals">
                  {strings.reviewIntervention}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

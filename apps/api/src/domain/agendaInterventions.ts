/**
 * Builds the Heute "standing focus" intervention section (feature spec §6).
 *
 * This is deliberately a sibling of the task agenda: it never enters task
 * selection, never consumes a Heute slot, and never joins the derived Review
 * queue (`reviewItems.ts`). It only *reads* the Phase 1 goals journal and
 * reuses the Phase 1 read-time state (`deriveInterventionState`, exposed on
 * every `InterventionView` as `derivedState`/`withinReviewWindow`). Nothing
 * here is stored or time-triggered.
 *
 * `running` surfaces every active-goal intervention that is still running;
 * `review` surfaces finished, unreviewed interventions that are still inside
 * the 7-day review window. Reviewed interventions appear in neither and drop
 * off Heute entirely, remaining visible only on the Goals page.
 */
import type {
  AgendaIntervention,
  AgendaInterventionBacking,
  AgendaInterventionFocus,
  GoalArea,
  GoalWithInterventions,
  InterventionView,
} from "@machbar/shared";
import { and, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { calendarDaysBetween } from "./calendarDate.js";
import { listGoals } from "./goals.js";

export interface AgendaInterventionFocusOptions {
  /**
   * The resolved viewer. Goals are always owner-scoped per-user, so the section
   * is only ever the viewer's own goals. Omitted for the household-wide "all"
   * overview, which surfaces no goals at all (goals are never shared).
   */
  memberId?: number;
  scope: "mine" | "all" | "work";
  today: string;
}

function periodProgress(intervention: InterventionView, today: string): {
  periodDay: number;
  periodLength: number;
} {
  const periodLength = Math.max(
    1,
    calendarDaysBetween(intervention.startDate, intervention.revisitDate),
  );
  const elapsed = calendarDaysBetween(intervention.startDate, today) + 1;
  const periodDay = Math.min(Math.max(elapsed, 1), periodLength);
  return { periodDay, periodLength };
}

function toAgendaIntervention(
  goal: GoalWithInterventions,
  intervention: InterventionView,
  today: string,
  backing: AgendaInterventionBacking | null,
): AgendaIntervention {
  const { periodDay, periodLength } = periodProgress(intervention, today);
  return {
    goalId: goal.id,
    goalTitle: goal.title,
    goalArea: goal.area,
    interventionId: intervention.id,
    revision: intervention.revision,
    type: intervention.type,
    commitment: intervention.commitment,
    startDate: intervention.startDate,
    revisitDate: intervention.revisitDate,
    periodDay,
    periodLength,
    derivedState: intervention.derivedState,
    withinReviewWindow: intervention.withinReviewWindow,
    backing,
  };
}

/**
 * Reads the crisp hit/miss tally for each backed intervention's recurring
 * check-in over its period so far (§8). The tally comes straight from the
 * canonical `task_recurrence_occurrences` the normal recurring-task machinery
 * records — this section only reads it, never writes task state.
 */
function backingTalliesByTask(
  db: Db,
  interventions: Array<{ backingTaskId: number | null; startDate: string }>,
  today: string,
): Map<number, AgendaInterventionBacking> {
  const taskIds = interventions
    .map((i) => i.backingTaskId)
    .filter((id): id is number => id !== null);
  const tallies = new Map<number, AgendaInterventionBacking>();
  if (taskIds.length === 0) return tallies;
  const rows = db
    .select({
      taskId: schema.taskRecurrenceOccurrences.taskId,
      result: schema.taskRecurrenceOccurrences.result,
    })
    .from(schema.taskRecurrenceOccurrences)
    .where(
      and(
        inArray(schema.taskRecurrenceOccurrences.taskId, taskIds),
        lte(schema.taskRecurrenceOccurrences.completedOn, today),
      ),
    )
    .all();
  for (const taskId of taskIds) {
    tallies.set(taskId, { taskId, hits: 0, misses: 0 });
  }
  for (const row of rows) {
    const tally = tallies.get(row.taskId);
    if (!tally) continue;
    if (row.result === "hit") tally.hits += 1;
    else tally.misses += 1;
  }
  return tallies;
}

export function buildAgendaInterventionFocus(
  db: Db,
  options: AgendaInterventionFocusOptions,
): AgendaInterventionFocus {
  // Goals are always owner-scoped per-user and never shared. The household
  // overview ("all") therefore surfaces no goals. The "work" view shows the
  // viewer's work-area goals; the personal "mine" view shows the viewer's
  // personal-area goals. When no viewer is known the section is empty rather
  // than leaking another owner's goals.
  const filter =
    options.scope === "all" || options.memberId === undefined
      ? null
      : {
          ownerMemberId: options.memberId,
          area: options.scope === "work" ? ("work" as GoalArea) : ("personal" as GoalArea),
        };
  if (filter === null) {
    return { running: [], review: [] };
  }

  const goals = listGoals(db, filter, options.today).filter(
    (goal) => goal.status === "active",
  );

  const allInterventions = goals.flatMap((goal) => goal.interventions);
  const backingTallies = backingTalliesByTask(db, allInterventions, options.today);

  const running: AgendaIntervention[] = [];
  const review: AgendaIntervention[] = [];
  for (const goal of goals) {
    for (const intervention of goal.interventions) {
      const backing =
        intervention.backingTaskId === null
          ? null
          : backingTallies.get(intervention.backingTaskId) ?? {
              taskId: intervention.backingTaskId,
              hits: 0,
              misses: 0,
            };
      if (intervention.derivedState === "running") {
        running.push(
          toAgendaIntervention(goal, intervention, options.today, backing),
        );
      } else if (
        intervention.derivedState === "finished" &&
        intervention.withinReviewWindow
      ) {
        review.push(
          toAgendaIntervention(goal, intervention, options.today, backing),
        );
      }
    }
  }
  return { running, review };
}

import type {
  ContributionCategory,
  ContributionEntityType,
  ContributionPulseLevel,
  ContributionReason,
  ContributionSummary,
} from "@machbar/shared";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;

export const CONTRIBUTION_POLICY = {
  points: {
    task_completed: 2,
    recurrence_missed: -1,
    project_completed: 4,
    task_clarified: 1,
    task_assigned: 1,
    task_estimated: 1,
    task_planned: 1,
    waiting_followup_added: 1,
    task_broken_down: 1,
    project_outcome_added: 1,
    project_driver_assigned: 1,
    project_next_action_added: 1,
    project_due_plan_added: 1,
  } satisfies Record<ContributionReason, number>,
  rollingDayCaps: {
    completion: 4,
    planning: 3,
    total: 6,
  },
  pulseLevels: {
    low: 1,
    medium: 3,
    high: 6,
  },
} as const;

export interface RecordContributionInput {
  activityEventId: number;
  actorMemberId: number | null;
  category: ContributionCategory;
  reason: ContributionReason;
  entityType: ContributionEntityType;
  entityId: number;
  personalEligible: boolean;
  now?: Date;
}

export interface NeutralizeContributionInput {
  activityEventId: number;
  entityType: ContributionEntityType;
  entityId: number;
  reason: ContributionReason;
  now?: Date;
}

export interface NeutralizeEntityContributionsInput {
  activityEventId: number;
  entityType: ContributionEntityType;
  entityId: number;
  now?: Date;
}

function cutoff(now: Date, durationMs: number): string {
  return new Date(now.getTime() - durationMs).toISOString();
}

function pulseLevel(points: number): ContributionPulseLevel {
  if (points < 0) return "negative";
  if (points >= CONTRIBUTION_POLICY.pulseLevels.high) return "high";
  if (points >= CONTRIBUTION_POLICY.pulseLevels.medium) return "medium";
  if (points >= CONTRIBUTION_POLICY.pulseLevels.low) return "low";
  return "none";
}

export function recordContribution(
  db: Db,
  input: RecordContributionInput,
): typeof schema.contributionEvents.$inferSelect | null {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = db
    .select({ id: schema.contributionEvents.id })
    .from(schema.contributionEvents)
    .where(
      and(
        eq(schema.contributionEvents.entityType, input.entityType),
        eq(schema.contributionEvents.entityId, input.entityId),
        eq(schema.contributionEvents.reason, input.reason),
        gte(schema.contributionEvents.createdAt, cutoff(now, WINDOW_MS)),
      ),
    )
    .limit(1)
    .get();
  if (existing) return null;

  const policyPoints = CONTRIBUTION_POLICY.points[input.reason];
  if (input.actorMemberId === null && policyPoints >= 0) return null;

  if (policyPoints < 0) {
    return db
      .insert(schema.contributionEvents)
      .values({
        createdAt: nowIso,
        activityEventId: input.activityEventId,
        actorMemberId: input.actorMemberId,
        category: input.category,
        reason: input.reason,
        entityType: input.entityType,
        entityId: input.entityId,
        policyPoints,
        sharedPoints: policyPoints,
        personalPoints:
          input.personalEligible && input.actorMemberId !== null
            ? policyPoints
            : 0,
      })
      .returning()
      .get();
  }
  const actorMemberId = input.actorMemberId!;

  const recent = db
    .select({
      category: schema.contributionEvents.category,
      points: schema.contributionEvents.sharedPoints,
    })
    .from(schema.contributionEvents)
    .where(
      and(
        eq(schema.contributionEvents.actorMemberId, actorMemberId),
        gte(schema.contributionEvents.createdAt, cutoff(now, DAY_MS)),
      ),
    )
    .all();
  const categoryUsed = recent
    .filter((row) => row.category === input.category)
    .reduce((total, row) => total + Math.max(0, row.points), 0);
  const totalUsed = recent.reduce(
    (total, row) => total + Math.max(0, row.points),
    0,
  );
  const awardedPoints = Math.max(
    0,
    Math.min(
      policyPoints,
      CONTRIBUTION_POLICY.rollingDayCaps[input.category] - categoryUsed,
      CONTRIBUTION_POLICY.rollingDayCaps.total - totalUsed,
    ),
  );

  return db
    .insert(schema.contributionEvents)
    .values({
      createdAt: nowIso,
      activityEventId: input.activityEventId,
      actorMemberId,
      category: input.category,
      reason: input.reason,
      entityType: input.entityType,
      entityId: input.entityId,
      policyPoints,
      sharedPoints: awardedPoints,
      personalPoints: input.personalEligible ? awardedPoints : 0,
    })
    .returning()
    .get();
}

export function neutralizeContribution(
  db: Db,
  input: NeutralizeContributionInput,
): void {
  const now = input.now ?? new Date();
  const award = db
    .select({ id: schema.contributionEvents.id })
    .from(schema.contributionEvents)
    .where(
      and(
        eq(schema.contributionEvents.entityType, input.entityType),
        eq(schema.contributionEvents.entityId, input.entityId),
        eq(schema.contributionEvents.reason, input.reason),
        gte(schema.contributionEvents.createdAt, cutoff(now, WINDOW_MS)),
        isNull(schema.contributionEvents.neutralizedAt),
      ),
    )
    .orderBy(
      desc(schema.contributionEvents.createdAt),
      desc(schema.contributionEvents.id),
    )
    .limit(1)
    .get();
  if (!award) return;

  db.update(schema.contributionEvents)
    .set({
      neutralizedAt: now.toISOString(),
      neutralizedByActivityEventId: input.activityEventId,
    })
    .where(eq(schema.contributionEvents.id, award.id))
    .run();
}

export function neutralizeEntityContributions(
  db: Db,
  input: NeutralizeEntityContributionsInput,
): void {
  const now = input.now ?? new Date();
  db.update(schema.contributionEvents)
    .set({
      neutralizedAt: now.toISOString(),
      neutralizedByActivityEventId: input.activityEventId,
    })
    .where(
      and(
        eq(schema.contributionEvents.entityType, input.entityType),
        eq(schema.contributionEvents.entityId, input.entityId),
        gte(schema.contributionEvents.createdAt, cutoff(now, WINDOW_MS)),
        isNull(schema.contributionEvents.neutralizedAt),
      ),
    )
    .run();
}

export function getContributionSummary(
  db: Db,
  now = new Date(),
): ContributionSummary {
  const windowStartedAt = cutoff(now, WINDOW_MS);
  const rows = db
    .select({
      actorMemberId: schema.contributionEvents.actorMemberId,
      createdAt: schema.contributionEvents.createdAt,
      category: schema.contributionEvents.category,
      sharedPoints: schema.contributionEvents.sharedPoints,
      personalPoints: schema.contributionEvents.personalPoints,
    })
    .from(schema.contributionEvents)
    .where(
      and(
        gte(schema.contributionEvents.createdAt, windowStartedAt),
        lte(schema.contributionEvents.createdAt, now.toISOString()),
        isNull(schema.contributionEvents.neutralizedAt),
      ),
    )
    .all();
  const members = db
    .select({
      id: schema.members.id,
      name: schema.members.name,
      color: schema.members.color,
      pictureUrl: schema.memberOidcIdentities.pictureUrl,
    })
    .from(schema.members)
    .leftJoin(
      schema.memberOidcIdentities,
      eq(schema.members.id, schema.memberOidcIdentities.memberId),
    )
    .all()
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  const sharedCategories = { completion: 0, planning: 0 };
  const pulsePoints = Array.from({ length: 7 }, () => 0);
  const windowStartedAtMs = Date.parse(windowStartedAt);
  let personalTotal = 0;
  for (const row of rows) {
    sharedCategories[row.category] += row.sharedPoints;
    const bucketIndex = Math.min(
      6,
      Math.floor((Date.parse(row.createdAt) - windowStartedAtMs) / DAY_MS),
    );
    if (bucketIndex >= 0) {
      pulsePoints[bucketIndex] =
        (pulsePoints[bucketIndex] ?? 0) + row.sharedPoints;
    }
    if (row.actorMemberId !== null) personalTotal += row.personalPoints;
  }

  return {
    windowStartedAt,
    windowEndedAt: now.toISOString(),
    sharedTotal: sharedCategories.completion + sharedCategories.planning,
    sharedOnlyTotal:
      sharedCategories.completion + sharedCategories.planning - personalTotal,
    sharedCategories,
    members: members.map((member) => {
      const categories = { completion: 0, planning: 0 };
      for (const row of rows) {
        if (row.actorMemberId === member.id) {
          categories[row.category] += row.personalPoints;
        }
      }
      return {
        member: { ...member, pictureUrl: member.pictureUrl ?? null },
        total: categories.completion + categories.planning,
        categories,
      };
    }),
    pulse: pulsePoints.map((points, index) => ({
      startedAt: new Date(windowStartedAtMs + index * DAY_MS).toISOString(),
      endedAt: new Date(windowStartedAtMs + (index + 1) * DAY_MS).toISOString(),
      level: pulseLevel(points),
    })),
  };
}

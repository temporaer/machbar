import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDraftFromPlan,
  intakeDraftIssues,
  intakePlanIssues,
  intakeSelectedDraftIssues,
  normalizeIntakeNullableAbsenceFields,
  normalizeIntakePlan,
  normalizeIntakeTimestamp,
  prepareIncompleteIntakeDraft,
  type IntakePlan,
} from "@machbar/shared";
import {
  intakePlanSchema,
  intakePlanStructureSchema,
  intakeDraftSchema,
} from "../src/schemas.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/shared/fixtures/intake-plan",
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

describe("intake plan contracts", () => {
  it("accepts every valid fixture", () => {
    for (const name of readdirSync(fixtures).filter((file) => file.startsWith("valid-"))) {
      const result = intakePlanSchema.safeParse(readFixture(name));
      expect(result.success, name).toBe(true);
      if (result.success) expect(intakePlanIssues(result.data as IntakePlan)).toEqual([]);
    }
  });

  it("rejects every invalid fixture", () => {
    for (const name of readdirSync(fixtures).filter((file) => file.startsWith("invalid-"))) {
      expect(intakePlanSchema.safeParse(readFixture(name)).success, name).toBe(false);
    }
  });

  it("guards the shared fixture key contract", () => {
    const keys = readFixture("keys.json") as {
      plan: string[];
      calendarEvent: string[];
      workItem: string[];
      warning: string[];
    };
    const shape = (intakePlanSchema as any)._def.schema.shape;
    expect(Object.keys(shape).sort()).toEqual(keys.plan.sort());
    expect(Object.keys(shape.calendarEvents.element.shape).sort()).toEqual(
      keys.calendarEvent.sort(),
    );
    expect(Object.keys(shape.workItems.element.shape).sort()).toEqual(
      keys.workItem.sort(),
    );
    expect(Object.keys(shape.warnings.element.shape).sort()).toEqual(
      keys.warning.sort(),
    );
  });

  it("builds an enabled draft with owner resolution and assumed duration", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, [{ id: 7, name: "Alex" }]);
    expect(draft.calendarEvents[0]).toMatchObject({
      enabled: true,
      durationAssumed: true,
      endDateTime: "2026-10-08T18:00:00.000Z",
    });
    expect(draft.workItems[0]).toMatchObject({ enabled: true, ownerMemberId: null });
    expect(draft.warnings.some((warning) => warning.message.includes("60 min"))).toBe(true);
    expect(intakeDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("normalizes recoverable relationships and availability idempotently", () => {
    const plan: IntakePlan = {
      summary: "Recovery",
      calendarEvents: [{
        key: "event",
        title: "Termin",
        description: null,
        location: null,
        allDay: true,
        startDate: "2026-10-08",
        endDate: "2026-10-08",
        startDateTime: null,
        endDateTime: null,
        relatedWorkKeys: ["action", "action", "missing"],
      }],
      workItems: [{
        key: "action",
        kind: "action",
        title: "Aktion",
        notes: null,
        parentKey: "child",
        ownerName: null,
        dueDate: "2026-10-01",
        scheduledDate: "2026-10-02",
        notBeforeDate: "2026-10-08",
        notBeforeAt: null,
        reminders: [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }],
        needsClarification: true,
        relatedCalendarKeys: ["event", "event", "missing"],
      }, {
        key: "child",
        kind: "action",
        title: "Kind",
        notes: null,
        parentKey: "action",
        ownerName: null,
        dueDate: null,
        scheduledDate: null,
        notBeforeDate: null,
        notBeforeAt: "2026-10-08T10:00:00+02:00",
        reminders: [],
        needsClarification: false,
        relatedCalendarKeys: [],
      }],
      warnings: [],
    };

    const normalized = normalizeIntakePlan(plan);
    expect(normalized.plan.calendarEvents[0]?.relatedWorkKeys).toEqual(["action"]);
    expect(normalized.plan.workItems[0]?.relatedCalendarKeys).toEqual(["event"]);
    expect(normalized.plan.workItems[0]?.notBeforeAt).toBe("2026-10-07T22:00:00.000Z");
    expect(normalized.plan.workItems[1]?.notBeforeDate).toBe("2026-10-08");
    expect(normalized.plan.workItems[1]?.parentKey).toBeNull();
    expect(normalized.plan.workItems[0]?.parentKey).toBe("child");
    expect(normalized.warnings.some((warning) => warning.message.includes("dangling"))).toBe(true);
    expect(normalized.warnings.some((warning) => warning.message.includes("cycle"))).toBe(true);
    expect(normalizeIntakePlan(normalized.plan).plan).toEqual(normalized.plan);

    const semantic = intakePlanIssues(normalized.plan);
    expect(semantic.map((item) => item.code)).not.toContain("captured_reminder");
    expect(semantic.map((item) => item.code)).toContain("scheduling_order");
    expect(intakeDraftIssues(buildDraftFromPlan(normalized.plan, []), {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    }).map((item) => item.code)).not.toContain("captured_reminder");
  });

  it("preserves semantic refinement codes in Zod issues", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    plan.workItems[0]!.needsClarification = true;
    plan.workItems[0]!.reminders = [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }];
    const result = intakePlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("normalizes only nullable absence placeholders before strict validation", () => {
    const raw = readFixture("nullable-placeholders.json");
    const normalized = normalizeIntakeNullableAbsenceFields(raw);
    expect(intakePlanSchema.safeParse(normalized).success).toBe(true);
    const plan = normalized as IntakePlan;
    expect(plan.workItems[0]).toMatchObject({
      notes: "null",
      parentKey: null,
      ownerName: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
    });
    expect(plan.workItems[1]).toMatchObject({
      notes: "none",
      parentKey: null,
      ownerName: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
    });
  });

  it("keeps malformed nonempty dates reviewable but blocks strict validation", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    plan.workItems[0]!.dueDate = "tomorrow";
    const structure = intakePlanStructureSchema.safeParse(plan);
    expect(structure.success).toBe(true);
    expect(intakePlanIssues(plan)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["workItems", 0, "dueDate"],
        code: "invalid_date",
        message: expect.stringContaining('"tomorrow"'),
      }),
    ]));
    const draft = buildDraftFromPlan(plan, []);
    expect(intakeSelectedDraftIssues(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["workItems", 0, "dueDate"],
        code: "invalid_date",
      }),
    ]));
  });

  it("validates only selected output while retaining original diagnostic paths", () => {
    const plan = readFixture("valid-project-tree.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, []);
    const disabledConflict = draft.workItems[0]!;
    disabledConflict.enabled = false;
    disabledConflict.needsClarification = true;
    disabledConflict.reminders = [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }];
    const reviewCodes = intakeDraftIssues(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    }).map((item) => item.code);
    expect(reviewCodes).not.toContain("captured_reminder");
    expect(intakeSelectedDraftIssues(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    })).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "captured_reminder" }),
    ]));

    const child = draft.workItems.find((item) => item.parentKey !== null);
    expect(child).toBeDefined();
    const parent = draft.workItems.find((item) => item.key === child?.parentKey);
    expect(parent).toBeDefined();
    parent!.enabled = false;
    const selectedIssues = intakeSelectedDraftIssues(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    });
    expect(selectedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "parent_disabled",
        path: ["workItems", draft.workItems.indexOf(child!), "parentKey"],
      }),
    ]));
  });

  it("prepares incomplete action drafts without mutating input", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, []);
    draft.workItems[0] = {
      ...draft.workItems[0]!,
      dueDate: "not-a-date",
      scheduledDate: "also-not-a-date",
      notBeforeDate: "2026-10-08",
      notBeforeAt: null,
      ownerMemberId: 99,
      reminders: [
        { kind: "absolute", at: "not-a-date" },
        { kind: "absolute", at: "2026-10-01T08:00:00+02:00" },
        { kind: "deadline_relative", daysBefore: 1, time: "08:00", timezone: "Europe/Berlin" },
      ],
      needsClarification: true,
    };

    const prepared = prepareIncompleteIntakeDraft(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    });

    expect(draft.workItems[0]?.dueDate).toBe("not-a-date");
    expect(prepared.draft.workItems[0]).toMatchObject({
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      ownerMemberId: null,
      needsClarification: true,
    });
    expect(prepared.draft.workItems[0]?.reminders).toEqual([
      { kind: "absolute", at: "2026-10-01T08:00:00+02:00" },
    ]);
    expect(prepared.omissions.map((item) => item.code)).toEqual(expect.arrayContaining([
      "invalid_date",
      "not_before_pair",
      "owner_not_member",
      "invalid_datetime",
      "deadline_relative_without_due",
    ]));
    expect(prepared.blockingIssues).toEqual([]);
  });

  it("keeps invalid selected calendar events blocked", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, []);
    draft.calendarEvents[0]!.endDateTime = "not-a-date";
    const prepared = prepareIncompleteIntakeDraft(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    });
    expect(prepared.omissions).toEqual([]);
    expect(prepared.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["calendarEvents", 0, "endDateTime"],
        code: "invalid_datetime",
      }),
    ]));
  });

  it("normalizes date-specific local timestamps without guessing DST transitions", () => {
    expect(normalizeIntakeTimestamp("2026-01-15T10:30", "Europe/Berlin")).toEqual({
      value: "2026-01-15T10:30:00+01:00",
      status: "normalized",
      timezoneInferred: true,
    });
    expect(normalizeIntakeTimestamp("2026-07-15T10:30", "Europe/Berlin")).toEqual({
      value: "2026-07-15T10:30:00+02:00",
      status: "normalized",
      timezoneInferred: true,
    });
    expect(normalizeIntakeTimestamp("2026-01-15T10:30+01:00", "America/Los_Angeles")).toEqual({
      value: "2026-01-15T10:30:00+01:00",
      status: "normalized",
      timezoneInferred: false,
    });
    expect(normalizeIntakeTimestamp("2026-01-15T10:30Z", "America/Los_Angeles")).toEqual({
      value: "2026-01-15T10:30:00Z",
      status: "normalized",
      timezoneInferred: false,
    });
    expect(normalizeIntakeTimestamp("2026-02-30T10:30", "Europe/Berlin").status).toBe("invalid");
    expect(normalizeIntakeTimestamp("2026-03-29T02:30", "Europe/Berlin").status).toBe("nonexistent");
    expect(normalizeIntakeTimestamp("2026-10-25T02:30", "Europe/Berlin").status).toBe("ambiguous");
  });

  it("prepares the same inferred timestamps for browser and server timezone contexts", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, []);
    draft.calendarEvents[0] = {
      ...draft.calendarEvents[0]!,
      startDateTime: "2026-07-15T10:30",
      endDateTime: "2026-07-15T11:30",
    };
    draft.workItems[0] = {
      ...draft.workItems[0]!,
      notBeforeDate: "2026-07-15",
      notBeforeAt: "2026-07-15T09:00",
      reminders: [{ kind: "absolute", at: "2026-07-15T08:00" }],
    };
    const options = {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
      timezone: "Europe/Berlin",
    };
    const browserPreparation = prepareIncompleteIntakeDraft(draft, options);
    const serverPreparation = prepareIncompleteIntakeDraft(draft, options);
    expect(serverPreparation).toEqual(browserPreparation);
    expect(browserPreparation.draft.calendarEvents[0]?.startDateTime).toBe("2026-07-15T10:30:00+02:00");
    expect(browserPreparation.draft.workItems[0]?.reminders).toEqual([
      { kind: "absolute", at: "2026-07-15T08:00:00+02:00" },
    ]);
    expect(browserPreparation.omissions).toEqual([]);
    expect(browserPreparation.inferredTimestamps).toHaveLength(4);
    expect(browserPreparation.blockingIssues).toEqual([]);
  });
});

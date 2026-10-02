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
  normalizeIntakeDraftInput,
  normalizeIntakePlanInput,
  normalizeIntakePlan,
  normalizeIntakeTimestamp,
  prepareIncompleteIntakeDraft,
  type IntakePlan,
} from "@machbar/shared";
import { normalizeStoredIntakeDraft } from "../src/intake/jobs.js";
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

  it("treats punctuation-only and null-like owner suggestions as absent", () => {
    const source = readFixture("valid-elternabend.json") as IntakePlan;
    const ownerNames: Array<string | null> = [".", "...", "-", "—", "  ", "none", "null", null, "Robin", "Alex", "None"];
    const plan: IntakePlan = {
      ...source,
      workItems: ownerNames.map((ownerName, index) => ({
        ...source.workItems[0]!,
        key: `owner-${index}`,
        title: `Owner ${index}`,
        parentKey: null,
        ownerName,
        relatedCalendarKeys: ["event"],
      })),
    };
    const draft = buildDraftFromPlan(plan, [
      { id: 7, name: "Alex" },
      { id: 8, name: "..." },
      { id: 9, name: "None" },
    ]);

    expect(draft.workItems.map((item) => item.ownerMemberId)).toEqual([
      null,
      8,
      null,
      null,
      null,
      9,
      null,
      null,
      null,
      7,
      9,
    ]);
    expect(draft.warnings.filter((warning) => warning.message.startsWith("Owner "))).toEqual([
      { message: "Owner 'Robin' is not a household member" },
    ]);
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
    expect(normalized.warnings.some((warning) => warning.message.includes("local-midnight"))).toBe(false);
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

  it("derives local-midnight availability without a routine warning", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    plan.workItems[0]!.notBeforeDate = "2026-10-02";
    plan.workItems[0]!.notBeforeAt = null;
    plan.warnings = [];

    const normalized = normalizeIntakePlan(plan);

    expect(normalized.plan.workItems[0]?.notBeforeAt).not.toBeNull();
    expect(normalized.warnings).toEqual([]);
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

  it("repairs compact AI plans without changing free text", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Flowers",
      extra: "ignored",
      calendarEvents: [],
      warnings: [],
      workItems: [{
        key: "water-flowers",
        kind: "action",
        title: "Blumen gießen",
        notes: ".",
        dueDate: ".",
        parentKey: ".",
        reminders: [{ kind: "absolute", at: "2026-10-09T08:00:00+02:00" }],
        unrelated: true,
      }],
    }) as IntakePlan & { extra?: unknown };
    expect(normalized.extra).toBeUndefined();
    expect(normalized.workItems[0]).toMatchObject({
      notes: ".",
      dueDate: null,
      parentKey: null,
      reminders: [{ kind: "absolute", at: "2026-10-09T08:00:00+02:00" }],
      relatedCalendarKeys: [],
      needsClarification: false,
    });
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      { message: expect.stringContaining("unsupported intake field") },
    ]));
  });

  it("repairs long AI keys with deterministic collision handling", () => {
    const sharedPrefix = "a".repeat(40);
    const normalized = normalizeIntakePlanInput({
      summary: "Key repair",
      calendarEvents: [
        { key: `${sharedPrefix}-first`, title: "First" },
        { key: `${sharedPrefix}-second`, title: "Second" },
        { key: "abcdef!", title: "Collides after repair" },
        { key: "abcdef", title: "Already canonical" },
        { key: "calendar-kur-haushaltshilfe-2026-10-05-26", title: "Reported event" },
        { key: "CALENDAR-KÜR!!!", title: "Unsupported characters" },
      ],
      workItems: [],
    }) as IntakePlan;
    const keys = normalized.calendarEvents.map((event) => event.key);

    expect(keys[0]).toBe(sharedPrefix);
    expect(keys[1]).toBe(`${"a".repeat(38)}-2`);
    expect(keys[2]).toBe("abcdef-2");
    expect(keys[3]).toBe("abcdef");
    expect(keys[4]).toBe("calendar-kur-haushaltshilfe-2026-10-05-26".slice(0, 40));
    expect(keys[5]).toBe("calendar-k-r");
    expect(keys.every((key) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(key))).toBe(true);
    expect(normalized.warnings).toEqual([]);
  });

  it("rewrites parents and calendar relationships when their keys are repaired", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Relationships",
      calendarEvents: [{
        key: "Calendar Event!!!",
        title: "Event",
        relatedWorkKeys: ["Child Task!!!"],
      }],
      workItems: [{
        key: "Parent Project!!!",
        kind: "project",
        title: "Project",
      }, {
        key: "Child Task!!!",
        kind: "action",
        title: "Action",
        parentKey: "Parent Project!!!",
        relatedCalendarKeys: ["Calendar Event!!!"],
      }],
    }) as IntakePlan;

    expect(normalized.calendarEvents[0]).toMatchObject({
      key: "calendar-event",
      relatedWorkKeys: ["child-task"],
    });
    expect(normalized.workItems.map((item) => item.key)).toEqual(["parent-project", "child-task"]);
    expect(normalized.workItems[1]).toMatchObject({
      parentKey: "parent-project",
      relatedCalendarKeys: ["calendar-event"],
    });
  });

  it("keeps duplicate original keys and missing or invalid keys as errors", () => {
    const duplicate = normalizeIntakePlanInput({
      summary: "Duplicate",
      calendarEvents: [],
      workItems: [
        { key: "Duplicate Key!!!", kind: "action", title: "First" },
        { key: "Duplicate Key!!!", kind: "action", title: "Second" },
      ],
    }) as IntakePlan;
    expect(duplicate.workItems.map((item) => item.key)).toEqual([
      "duplicate-key",
      "duplicate-key",
    ]);
    expect(intakePlanIssues(duplicate).map((item) => item.code)).toContain("duplicate_key");
    expect(intakePlanSchema.safeParse(duplicate).success).toBe(false);

    for (const key of [undefined, 42]) {
      const workItem = key === undefined
        ? { kind: "action", title: "Missing key" }
        : { key, kind: "action", title: "Invalid key" };
      const normalized = normalizeIntakePlanInput({
        summary: "Invalid key",
        calendarEvents: [],
        workItems: [workItem],
      }) as { workItems: Array<Record<string, unknown>> };
      if (key === undefined) expect(normalized.workItems[0]).not.toHaveProperty("key");
      else expect(normalized.workItems[0]?.key).toBe(key);
      expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(false);
    }
    const empty = normalizeIntakePlanInput({
      summary: "Empty key",
      calendarEvents: [],
      workItems: [{ key: "", kind: "action", title: "Empty key" }],
    }) as IntakePlan;
    expect(empty.workItems[0]?.key).toBe("");
    expect(intakePlanIssues(empty).map((item) => item.code)).toContain("key_invalid");
    expect(intakePlanSchema.safeParse(empty).success).toBe(false);
  });

  it("preserves unresolved relationships and their diagnostics after key repair", () => {
    const source = readFixture("valid-elternabend.json") as IntakePlan;
    source.calendarEvents[0]!.key = "Long Calendar Event!!!";
    source.calendarEvents[0]!.relatedWorkKeys = ["Long Work Item!!!", "missing-work"];
    source.workItems[0]!.key = "Long Work Item!!!";
    source.workItems[0]!.parentKey = "missing-parent";
    source.workItems[0]!.relatedCalendarKeys = ["Long Calendar Event!!!", "missing-calendar"];

    const normalized = normalizeIntakePlanInput(source) as IntakePlan;
    expect(normalized.workItems[0]?.parentKey).toBe("missing-parent");
    expect(normalized.calendarEvents[0]?.relatedWorkKeys).toEqual(["long-work-item", "missing-work"]);
    expect(normalized.workItems[0]?.relatedCalendarKeys).toEqual(["long-calendar-event", "missing-calendar"]);
    expect(intakePlanIssues(normalized).map((item) => item.code)).toEqual(expect.arrayContaining([
      "dangling_parent",
      "dangling_related_key",
    ]));
  });

  it("preserves valid keys and is idempotent", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const normalized = normalizeIntakePlanInput(plan) as IntakePlan;
    expect(normalized).toEqual(plan);
    expect(normalizeIntakePlanInput(normalized)).toEqual(normalized);
  });

  it("normalizes missing and null booleans, collections, and relationships", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Defaults",
      calendarEvents: [{
        key: "event",
        title: "Event",
        allDay: null,
        relatedWorkKeys: null,
      }, {
        key: "event-defaults",
        title: "Event defaults",
      }],
      workItems: [{
        key: "action",
        kind: "action",
        title: "Action",
        needsClarification: null,
        reminders: null,
        relatedCalendarKeys: null,
      }, {
        key: "explicit",
        kind: "action",
        title: "Explicit",
        needsClarification: true,
        reminders: [],
        relatedCalendarKeys: [],
      }, {
        key: "missing-defaults",
        kind: "action",
        title: "Missing defaults",
      }],
      warnings: null,
    }) as IntakePlan;

    expect(normalized.calendarEvents[0]).toMatchObject({
      allDay: false,
      relatedWorkKeys: [],
    });
    expect(normalized.calendarEvents[1]).toMatchObject({
      allDay: false,
      relatedWorkKeys: [],
    });
    expect(normalized.workItems[0]).toMatchObject({
      needsClarification: false,
      reminders: [],
      relatedCalendarKeys: [],
    });
    expect(normalized.workItems[1]).toMatchObject({
      needsClarification: true,
      reminders: [],
      relatedCalendarKeys: [],
    });
    expect(normalized.workItems[2]).toMatchObject({
      needsClarification: false,
      reminders: [],
      relatedCalendarKeys: [],
    });
    expect(normalized.warnings).toEqual([]);
    expect(normalizeIntakePlanInput({
      summary: "Null root",
      calendarEvents: null,
      workItems: null,
      warnings: null,
    })).toMatchObject({ calendarEvents: [], workItems: [], warnings: [] });
    expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(true);
  });

  it.each([
    [["calendarEvents", 0, "allDay"], 0],
    [["calendarEvents", 0, "relatedWorkKeys"], "[]"],
    [["workItems", 0, "needsClarification"], "false"],
    [["workItems", 0, "reminders"], {}],
    [["workItems", 0, "relatedCalendarKeys"], 0],
  ] as const)("preserves wrong non-null values for validation at %j", (path, value) => {
    const normalized = normalizeIntakePlanInput({
      summary: "Wrong value",
      calendarEvents: [{ key: "event", title: "Event" }],
      workItems: [{ key: "action", kind: "action", title: "Action" }],
      [path[0]!]: path[0] === "calendarEvents"
        ? [{ key: "event", title: "Event", [path[2]!]: value }]
        : [{ key: "action", kind: "action", title: "Action", [path[2]!]: value }],
    });
    const result = intakePlanStructureSchema.safeParse(normalized);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path }),
      ]));
    }
  });

  it("discards project-only task fields before validation with one warning", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Project metadata",
      workItems: [{
        key: "garden",
        kind: "project",
        title: "Garden",
        dueDate: "2026-10-10",
        scheduledDate: "2026-10-05",
        notBeforeDate: 42,
        notBeforeAt: {},
        reminders: { malformed: true },
        needsClarification: true,
      }],
    }) as IntakePlan;

    expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(true);
    expect(normalized.workItems[0]).toMatchObject({
      kind: "project",
      dueDate: "2026-10-10",
      scheduledDate: "2026-10-05",
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(normalized.warnings).toEqual([
      { message: "Ignored task-only fields on project 'garden'." },
    ]);
  });

  it("does not warn for default project task fields or discard supported fields", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Project defaults",
      workItems: [{
        key: "garden",
        kind: "project",
        title: "Garden",
        notes: "Notes",
        ownerName: "Alex",
        parentKey: "parent",
        dueDate: "2026-10-10",
        scheduledDate: "2026-10-05",
        notBeforeDate: null,
        notBeforeAt: null,
        reminders: [],
        needsClarification: false,
      }],
    }) as IntakePlan;

    expect(normalized.warnings).toEqual([]);
    expect(normalized.workItems[0]).toMatchObject({
      notes: "Notes",
      ownerName: "Alex",
      parentKey: "parent",
      dueDate: "2026-10-10",
      scheduledDate: "2026-10-05",
    });
  });

  it.each([
    ["notBeforeDate", false],
    ["notBeforeAt", false],
    ["reminders", false],
    ["needsClarification", false],
  ] as const)("discards false project task-only field %s without warning", (field, value) => {
    const normalized = normalizeIntakePlanInput({
      summary: "Project default",
      workItems: [{
        key: "garden",
        kind: "project",
        title: "Garden",
        [field]: value,
      }],
    }) as IntakePlan;

    expect(normalized.workItems[0]).toMatchObject({
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(normalized.warnings).toEqual([]);
    expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(true);
  });

  it("discards mixed meaningful and default project fields with one warning", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Mixed project fields",
      workItems: [{
        key: "garden",
        kind: "project",
        title: "Garden",
        notBeforeDate: "2026-10-10",
        notBeforeAt: false,
        reminders: [],
        needsClarification: false,
      }],
    }) as IntakePlan;

    expect(normalized.workItems[0]).toMatchObject({
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(normalized.warnings).toEqual([
      { message: "Ignored task-only fields on project 'garden'." },
    ]);
    expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(true);
  });

  it("keeps valid reminders on actions needing clarification", () => {
    const normalized = normalizeIntakePlanInput({
      summary: "Clarification",
      workItems: [{
        key: "action",
        kind: "action",
        title: "Clarify",
        needsClarification: true,
        reminders: [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }],
      }],
    }) as IntakePlan;

    expect(normalized.workItems[0]).toMatchObject({
      needsClarification: true,
      reminders: [{ kind: "absolute", at: "2026-10-01T08:00:00+02:00" }],
    });
  });

  it.each([
      ["calendarEvents", { unexpected: true }],
      ["calendarEvents", "not-an-array"],
      ["workItems", { unexpected: true }],
      ["workItems", "not-an-array"],
      ["warnings", { unexpected: true }],
      ["warnings", "not-an-array"],
  ] as const)("preserves an explicitly supplied wrong-type %s collection", (field, value) => {
    const normalized = normalizeIntakePlanInput({
      summary: "Wrong collection",
      [field]: value,
    }) as Record<string, unknown>;
    expect(normalized[field]).toEqual(value);
    expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(false);
  });

  it.each(["calendarEvents", "workItems", "warnings"] as const)(
    "defaults an omitted %s collection without weakening structure validation",
    (field) => {
      const normalized = normalizeIntakePlanInput({ summary: "Omitted collection" }) as Record<
        string,
        unknown
      >;
      expect(normalized[field]).toEqual([]);
      expect(intakePlanStructureSchema.safeParse(normalized).success).toBe(true);
    },
  );

  it("normalizes the flower-watering proposal without bogus parent diagnostics", () => {
    const source = readFixture("valid-flower-watering.json") as IntakePlan;
    const compact = normalizeIntakePlanInput({
      summary: source.summary,
      workItems: [{
        key: "water-flowers",
        kind: "action",
        title: source.workItems[0]!.title,
        notes: ".",
        parentKey: ".",
        dueDate: ".",
        scheduledDate: source.workItems[0]!.scheduledDate,
        notBeforeDate: ".",
        notBeforeAt: ".",
        ownerName: ".",
        reminders: source.workItems[0]!.reminders,
      }],
    }) as IntakePlan;
    const normalized = normalizeIntakePlan(compact).plan;
    const draft = buildDraftFromPlan(normalized, []);
    expect(draft.workItems[0]).toMatchObject({
      notes: ".",
      parentKey: null,
      dueDate: null,
      scheduledDate: "2026-10-03",
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: source.workItems[0]!.reminders,
    });
    expect(draft.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("parent") })]),
    );
  });

  it("normalizes stored legacy drafts without rewriting free text", () => {
    const normalized = normalizeStoredIntakeDraft({
      calendarEvents: null,
      workItems: [{
        key: "water-flowers",
        notes: ".",
        ownerName: ".",
        dueDate: ".",
        parentKey: ".",
        enabled: false,
        ownerMemberId: 17,
        needsClarification: null,
        relatedCalendarKeys: null,
        reminderAt: "2026-10-03T08:00:00+02:00",
      }, {
        key: "empty-reminders",
        reminders: null,
        enabled: true,
        ownerMemberId: null,
      }],
      warnings: null,
      retainSourceInPaperless: true,
    });
    expect(normalized?.workItems[0]).toMatchObject({
      notes: ".",
      ownerName: null,
      dueDate: null,
      parentKey: null,
      reminders: [{ kind: "absolute", at: "2026-10-03T08:00:00+02:00" }],
      needsClarification: false,
      relatedCalendarKeys: [],
      enabled: false,
      ownerMemberId: 17,
    });
    expect(normalized?.workItems[1]).toMatchObject({
      reminders: [],
      needsClarification: false,
      relatedCalendarKeys: [],
      enabled: true,
      ownerMemberId: null,
    });
    expect(normalized).toMatchObject({
      calendarEvents: [],
      warnings: [],
      retainSourceInPaperless: true,
    });
    expect(normalizeIntakeDraftInput({
      workItems: [{ key: "project", kind: "project", notBeforeDate: "2026-10-01", enabled: false }],
    })).toMatchObject({
      workItems: [{ notBeforeDate: null, enabled: false }],
      warnings: [{ message: "Ignored task-only fields on project 'project'." }],
    });
  });

  it("preserves a real member whose name looks like a placeholder", () => {
    const normalized = normalizeIntakeNullableAbsenceFields({
      workItems: [{ ownerName: "None", notes: "." }],
    }, { ownerNames: ["None"] }) as { workItems: Array<{ ownerName: string | null; notes: string }> };
    expect(normalized.workItems[0]).toEqual({ ownerName: "None", notes: "." });
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
    expect(normalizeIntakeTimestamp("2026-01-15T10:30.1234", "Europe/Berlin")).toEqual({
      value: "2026-01-15T10:30:00.1234+01:00",
      status: "normalized",
      timezoneInferred: true,
    });
    expect(normalizeIntakeTimestamp("2026-01-15T10:30.0001", "Europe/Berlin")).toEqual({
      value: "2026-01-15T10:30:00.0001+01:00",
      status: "normalized",
      timezoneInferred: true,
    });
    expect(normalizeIntakeTimestamp("2026-01-15T10:30.123456789", "Europe/Berlin")).toEqual({
      value: "2026-01-15T10:30:00.123456789+01:00",
      status: "normalized",
      timezoneInferred: true,
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
    expect(browserPreparation.normalizedTimestamps).toHaveLength(4);
    expect(browserPreparation.normalizedTimestamps.every((item) => item.timezone === "Europe/Berlin")).toBe(true);
    expect(browserPreparation.blockingIssues).toEqual([]);
  });

  it("records successful seconds-only normalization without timezone inference", () => {
    const plan = readFixture("valid-elternabend.json") as IntakePlan;
    const draft = buildDraftFromPlan(plan, []);
    draft.calendarEvents[0] = {
      ...draft.calendarEvents[0]!,
      startDateTime: "2026-01-15T10:30+01:00",
      endDateTime: "2026-01-15T11:30Z",
    };
    const prepared = prepareIncompleteIntakeDraft(draft, {
      memberIds: [],
      paperlessAvailable: true,
      hasFiles: false,
    });
    expect(prepared.normalizedTimestamps).toEqual([
      expect.objectContaining({
        path: ["calendarEvents", 0, "startDateTime"],
        originalValue: "2026-01-15T10:30+01:00",
        value: "2026-01-15T10:30:00+01:00",
        secondsAdded: true,
        timezone: null,
      }),
      expect.objectContaining({
        path: ["calendarEvents", 0, "endDateTime"],
        originalValue: "2026-01-15T11:30Z",
        value: "2026-01-15T11:30:00Z",
        secondsAdded: true,
        timezone: null,
      }),
    ]);
    expect(prepared.omissions).toEqual([]);
    expect(prepared.blockingIssues).toEqual([]);
  });
});

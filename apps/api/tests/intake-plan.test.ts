import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDraftFromPlan,
  intakePlanIssues,
  type IntakePlan,
} from "@machbar/shared";
import {
  intakePlanSchema,
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
});

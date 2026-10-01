import { describe, expect, it } from "vitest";
import type { IntakeDraftCalendarEvent, IntakeDraftWorkItem } from "@machbar/shared";
import {
  berlinDateForInstant,
  issuesForPath,
  transitionCalendarAllDay,
  transitionWorkItemKind,
  workItemDepths,
} from "./intakeDraft";
import { taskAvailabilityClock, taskAvailabilityForLocalDate } from "./taskAvailability";

const calendarEvent: IntakeDraftCalendarEvent = {
  key: "event",
  title: "Termin",
  description: null,
  location: null,
  allDay: false,
  startDate: null,
  endDate: null,
  startDateTime: "2026-10-08T19:00:00+02:00",
  endDateTime: "2026-10-09T00:30:00+02:00",
  relatedWorkKeys: [],
  enabled: true,
  durationAssumed: true,
};

function item(
  key: string,
  kind: IntakeDraftWorkItem["kind"],
  parentKey: string | null = null,
  values: Partial<IntakeDraftWorkItem> = {},
): IntakeDraftWorkItem {
  return {
    key,
    kind,
    title: `${key} title`,
    notes: `${key} notes`,
    parentKey,
    dueDate: "2026-10-20",
    scheduledDate: "2026-10-10",
    notBeforeDate: "2026-10-09",
    notBeforeAt: "2026-10-09T06:00:00.000Z",
    reminders: [{ kind: "absolute", at: "2026-10-10T06:00:00.000Z" }],
    needsClarification: true,
    relatedCalendarKeys: ["event"],
    enabled: true,
    ownerMemberId: 12,
    ...values,
  };
}

describe("AI intake draft helpers", () => {
  it("normalizes timed calendar events to Berlin all-day dates", () => {
    const next = transitionCalendarAllDay(calendarEvent, true);
    expect(next).toMatchObject({
      allDay: true,
      startDate: "2026-10-08",
      endDate: "2026-10-09",
      startDateTime: null,
      endDateTime: null,
      durationAssumed: false,
    });
    expect(berlinDateForInstant("not a date")).toBeNull();
  });

  it("normalizes all-day events to a reasonable timed start without inventing an end", () => {
    const next = transitionCalendarAllDay({
      ...calendarEvent,
      allDay: true,
      startDate: "2026-10-08",
      endDate: "2026-10-08",
      startDateTime: null,
      endDateTime: null,
    }, false);
    expect(next.allDay).toBe(false);
    expect(next.startDate).toBeNull();
    expect(next.endDate).toBeNull();
    expect(next.startDateTime).toBe("2026-10-08T07:00:00.000Z");
    expect(next.endDateTime).toBeNull();
    expect(next.durationAssumed).toBe(false);
  });

  it("converts action to project while retaining meaningful fields and legalizing its parent", () => {
    const project = item("project", "project", null, { scheduledDate: null, notBeforeDate: null, notBeforeAt: null, reminders: [], needsClarification: false });
    const actionParent = item("parent", "action", "project");
    const action = item("child", "action", "parent");
    const next = transitionWorkItemKind([project, actionParent, action], action.key, "project")[2];
    expect(next).toMatchObject({
      kind: "project",
      title: action.title,
      notes: action.notes,
      parentKey: "project",
      dueDate: action.dueDate,
      ownerMemberId: action.ownerMemberId,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it("converts action to reference retaining title, notes, and legal parent only", () => {
    const project = item("project", "project");
    const action = item("child", "action", "project");
    const next = transitionWorkItemKind([project, action], action.key, "reference")[1];
    expect(next).toMatchObject({
      kind: "reference",
      title: action.title,
      notes: action.notes,
      parentKey: "project",
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it("converts project to action without inventing scheduling or reminders", () => {
    const project = item("project", "project", null, {
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(transitionWorkItemKind([project], project.key, "action")[0]).toMatchObject({
      kind: "action",
      title: project.title,
      notes: project.notes,
      dueDate: project.dueDate,
      ownerMemberId: project.ownerMemberId,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it("converts project to reference while preserving a legal parent", () => {
    const parent = item("parent", "project", null);
    const project = item("project", "project", "parent");
    expect(transitionWorkItemKind([parent, project], project.key, "reference")[1]).toMatchObject({
      kind: "reference",
      parentKey: "parent",
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it("converts reference to action with empty action-only defaults", () => {
    const reference = item("reference", "reference", null, {
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(transitionWorkItemKind([reference], reference.key, "action")[0]).toMatchObject({
      kind: "action",
      title: reference.title,
      notes: reference.notes,
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it("converts reference to project without inventing due dates or owner changes", () => {
    const reference = item("reference", "reference", null, {
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(transitionWorkItemKind([reference], reference.key, "project")[0]).toMatchObject({
      kind: "project",
      dueDate: null,
      ownerMemberId: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it.each(["action", "reference"] as const)(
    "moves project children to a legal ancestor when a project becomes %s",
    (kind) => {
      const ancestor = item("ancestor", "project", null);
      const project = item("target", "project", "ancestor");
      const childProject = item("child-project", "project", "target");
      const childAction = item("child-action", "action", "target");
      const childReference = item("child-reference", "reference", "target");
      const grandchild = item("grandchild", "action", "child-action");
      const sibling = item("sibling", "action", "ancestor");
      const items = [ancestor, project, childProject, childAction, grandchild, childReference, sibling];
      const transitioned = transitionWorkItemKind(items, project.key, kind);
      expect(transitioned.map((entry) => entry.key)).toEqual(items.map((entry) => entry.key));
      expect(transitioned[2]?.parentKey).toBe("ancestor");
      expect(transitioned[3]?.parentKey).toBe(kind === "action" ? "target" : "ancestor");
      expect(transitioned[4]?.parentKey).toBe("child-action");
      expect(transitioned[5]?.parentKey).toBe(kind === "action" ? "target" : "ancestor");
      expect(transitioned[6]).toBe(sibling);
    },
  );

  it("reparents action children on action-to-reference and keeps their descendants", () => {
    const root = item("root", "project", null);
    const parent = item("parent", "action", "root");
    const child = item("child", "action", "parent");
    const grandchild = item("grandchild", "reference", "child");
    const transitioned = transitionWorkItemKind([root, parent, child, grandchild], "parent", "reference");
    expect(transitioned.map((entry) => entry.parentKey)).toEqual([null, "root", "root", "child"]);
  });

  it("moves project children to root when there is no legal ancestor", () => {
    const parent = item("parent", "project");
    const child = item("child", "project", "parent");
    expect(transitionWorkItemKind([parent, child], "parent", "action")[1]?.parentKey).toBeNull();
  });

  it("preserves legal children when action or reference becomes a project", () => {
    const root = item("root", "project");
    const action = item("action", "action", "root");
    const actionChild = item("action-child", "action", "action");
    expect(transitionWorkItemKind([root, action, actionChild], "action", "project")[2]?.parentKey).toBe("action");
    const reference = item("reference", "reference", "root", {
      ownerMemberId: null,
      dueDate: null,
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
    expect(transitionWorkItemKind([root, reference, item("child", "project", "reference")], "reference", "project")[2]?.parentKey).toBe("reference");
    expect(transitionWorkItemKind([root, reference, item("child", "action", "reference")], "reference", "action")[2]?.parentKey).toBe("reference");
  });

  it("derives indentation from parent depth rather than list position", () => {
    const items = [
      item("root", "project"),
      item("child", "action", "root"),
      item("second-root", "project"),
      item("other-root", "project"),
      item("grandchild", "action", "child"),
    ];
    expect(workItemDepths(items)).toEqual([0, 1, 0, 0, 2]);
    expect(workItemDepths([
      items[0]!,
      items[1]!,
      item("sibling", "action", "root"),
      items[3]!,
      items[4]!,
    ])).toEqual([0, 1, 1, 0, 2]);
  });

  it("uses exact paths for inline issue matching", () => {
    const issues = [
      { path: ["calendarEvents", 0, "endDateTime"], code: "timed_end_required" as const, message: "first" },
      { path: ["calendarEvents", 1, "endDateTime"], code: "timed_end_required" as const, message: "second" },
    ];
    expect(issuesForPath(issues, ["calendarEvents", 1, "endDateTime"])).toEqual([issues[1]]);
    expect(issuesForPath(issues, ["calendarEvents", 0])).toEqual([]);
  });

  it("keeps date-only and date-plus-time availability pairs coherent when dates change", () => {
    const dateOnly = taskAvailabilityForLocalDate("2026-10-08", null);
    expect(dateOnly?.notBeforeDate).toBe("2026-10-08");
    expect(taskAvailabilityClock(dateOnly?.notBeforeAt ?? null)).toBe("00:00");

    const timed = taskAvailabilityForLocalDate("2026-10-08", "15:30");
    expect(timed?.notBeforeDate).toBe("2026-10-08");
    expect(taskAvailabilityClock(timed?.notBeforeAt ?? null)).toBe("15:30");
    const changedDate = taskAvailabilityForLocalDate("2026-10-09", "15:30");
    expect(changedDate?.notBeforeDate).toBe("2026-10-09");
    expect(taskAvailabilityClock(changedDate?.notBeforeAt ?? null)).toBe("15:30");
    expect(taskAvailabilityForLocalDate("", null)).toBeNull();
  });
});

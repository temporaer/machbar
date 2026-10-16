import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { projectRailActions, taskRailActions } from "./workItemRail";

const now = new Date("2026-10-16T12:00:00Z");
const intents = (actions: ReturnType<typeof taskRailActions>) => actions.map((a) => a.intent);

describe("contextual task interventions", () => {
  it("offers planning, smaller steps and an external wait for ready work", () => {
    const task = makeTask();
    expect(intents(taskRailActions(task))).toEqual(["plan", "split", "wait"]);
    expect(taskRailActions(task).map((a) => a.command.type)).toEqual(["task.plan", "task.split", "task.waitingLifecycle"]);
    expect(intents(taskRailActions(makeTask({ status: "someday" })))).toEqual(["plan"]);
  });
  it("keeps recurring actions as leaves instead of offering an unsupported split", () => {
    expect(intents(taskRailActions(makeTask({ repeatAfterDays: 7 })))).toEqual(["plan", "wait"]);
  });
  it.each(["captured", "actionable", "someday"] as const)("prioritizes clarification independently of %s status", (status) => {
    expect(intents(taskRailActions(makeTask({ status, needsClarification: true }), true))).toEqual(["clarify", "deferClarification", "structure"]);
    expect(taskRailActions(makeTask({ status, needsClarification: true }))[0]).toMatchObject({ command: { type: "task.setClarification", requested: false }, prominent: true });
  });
  it("uses the same follow-up command in Today and ordinary lists without offering end-wait lifecycle", () => {
    const task = makeTask({ externalWait: { waitingFor: "Amt", revisitDate: null }, blocked: true });
    expect(taskRailActions(task, true)).toEqual(taskRailActions(task));
    expect(intents(taskRailActions(task))).toEqual(["followUp", "plan"]);
    expect(taskRailActions(task)[0]?.command).toEqual({ type: "task.waitingLifecycle", taskId: task.id });
  });
  it("opens the first unresolved prerequisite; never offers splitting or ignoring it", () => {
    const task = makeTask({ blocked: true, dependencies: [
      { id: 1, taskId: 1, dependsOnTaskId: 2, title: "Done", resolved: true },
      { id: 2, taskId: 1, dependsOnTaskId: 3, title: "Blocked", resolved: false },
    ] });
    expect(intents(taskRailActions(task, true))).toEqual(["inspectBlocker", "plan"]);
    expect(taskRailActions(task)[0]?.command).toEqual({ type: "task.open", taskId: 3 });
    expect(intents(taskRailActions(makeTask({ blocked: true })))).toEqual(["plan"]);
  });
  it("keeps explicit Today revisit decisions for otherwise ready work", () => {
    expect(intents(taskRailActions(makeTask(), true))).toEqual(["startToday", "availability", "plan"]);
  });
  it.each(["done", "cancelled"] as const)("offers no interventions on %s even with stale attention flags", (status) => {
    expect(taskRailActions(makeTask({ status, needsClarification: true, externalWait: { waitingFor: "Amt", revisitDate: null } }), true)).toEqual([]);
  });
  it("does not invent execution interventions for reference material or discussion marking", () => {
    expect(taskRailActions(makeTask({ kind: "reference" }))).toEqual([]);
    expect(intents(taskRailActions(makeTask({ discussionRequested: true })))).toEqual(["plan", "split", "wait"]);
  });
});

describe("contextual project interventions", () => {
  it("plans backlog activation with a revisit rather than a deadline or lifecycle transition", () => {
    const actions = projectRailActions(makeProject({ status: "backlog" }), now);
    expect(intents(actions)).toEqual(["planActivation", "outcome", "structure"]);
    expect(actions[0]).toMatchObject({ command: { type: "story.defer" }, prominent: true });
  });
  it.each(["no_next_action", "waiting_without_followup", "blocked_without_clear_path"] as const)("offers a next step for %s, with stable outcome/structure order", (stuckReason) => {
    expect(intents(projectRailActions(makeProject({ stuckReason }), now))).toEqual(["nextStep", "outcome", "structure"]);
  });
  it("reviews the outcome without offering completion or another next step", () => {
    const actions = projectRailActions(makeProject({ stuckReason: "completion_review" }), now);
    expect(intents(actions)).toEqual(["outcome"]);
    expect(actions[0]?.command.type).toBe("story.editOutcome");
  });
  it.each(["completed", "archived"] as const)("leaves %s lifecycle actions on the right", (status) => {
    expect(projectRailActions(makeProject({ status }), now)).toEqual([]);
  });
  it("does not duplicate viable or deferred next actions or invent aggregate follow-up", () => {
    for (const story of [
      makeProject({ nextAction: makeTask(), stuckReason: null }),
      makeProject({ nextAction: makeTask({ scheduledDate: "2026-10-20" }), stuckReason: null }),
      makeProject({ nextAction: null, deferredNextAction: makeTask(), stuckReason: null }),
      makeProject({ nextAction: null, stuckReason: null, waitingOn: ["Amt"] }),
    ]) expect(projectRailActions(story, now)).toEqual([]);
  });
});

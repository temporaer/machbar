import { describe, expect, it } from "vitest";
import {
  evaluateCommitmentTransition,
  hasExecutionCommitment,
  type CommitmentTransitionSnapshot,
} from "../src/domain/commitmentTransition.js";

function snapshot(overrides: Partial<CommitmentTransitionSnapshot> = {}): CommitmentTransitionSnapshot {
  return {
    today: "2026-10-11",
    subject: {
      type: "task",
      id: 90,
      status: "captured",
      targetStatus: "captured",
      executionCommitment: true,
      newExecutionCommitment: true,
      revisitAt: null,
      recurring: false,
      explicitlyReopened: false,
    },
    projects: [{
      projectId: 5,
      title: "Projekt",
      parentId: null,
      revision: 3,
      status: "backlog",
      ownerMemberId: 1,
      hasViableProgressPath: false,
      hasHealthyFutureWaiting: false,
      hasHealthyFutureRevisit: false,
    }],
    ...overrides,
  };
}

const resolution = (projectIds: number[], nextActionTitle?: string) => ({
  expectedProjects: projectIds.map((projectId) => ({ projectId, revision: projectId === 5 ? 3 : 8 })),
  drivers: [],
  ...(nextActionTitle ? { nextActionTitle } : {}),
});

describe("pure commitment transition decisions", () => {
  it.each(["captured", "someday"] as const)("an execution commitment overrides %s as the target status", (status) => {
    const input = snapshot({ subject: { ...snapshot().subject, status, targetStatus: status } });
    expect(evaluateCommitmentTransition(input, "commitment")).toMatchObject({
      kind: "needs_decisions",
    });
    const withPath = evaluateCommitmentTransition(input, "commitment", {
      resolution: resolution([5], "Ersten Schritt erledigen"),
    });
    expect(withPath).toMatchObject({
      kind: "ready",
      plan: {
        taskStatus: "actionable",
        projectActivations: [{ projectId: 5, ownerMemberId: 1 }],
        nextAction: { projectId: 5, title: "Ersten Schritt erledigen" },
      },
    });
  });

  it("treats a revisit notification as deliberate postponement, not an execution commitment", () => {
    expect(hasExecutionCommitment({
      kind: "action", dueDate: null, scheduledDate: null, revisitAt: "2026-12-01", reminders: [{}],
    })).toBe(false);
    const result = evaluateCommitmentTransition(snapshot({
      subject: { ...snapshot().subject, executionCommitment: false, newExecutionCommitment: false, revisitAt: "2026-12-01" },
    }), "commitment");
    expect(result).toMatchObject({ kind: "ready", plan: { projectActivations: [], nextAction: null } });
  });

  it("requires both a driver and a progress path, and accepts a user-proposed action in the same transition", () => {
    const noDriver = snapshot({ projects: [{ ...snapshot().projects[0]!, ownerMemberId: null }] });
    const missing = evaluateCommitmentTransition(noDriver, "commitment");
    expect(missing).toMatchObject({
      kind: "needs_decisions",
      decisionSnapshot: { projects: [{ required: ["driver", "progressPath"] }] },
    });
    const complete = evaluateCommitmentTransition(noDriver, "commitment", {
      resolution: {
        expectedProjects: [{ projectId: 5, revision: 3 }],
        drivers: [{ projectId: 5, ownerMemberId: 2 }],
        nextActionTitle: "Ersten Schritt erledigen",
      },
    });
    expect(complete).toMatchObject({ kind: "ready", plan: { nextAction: { title: "Ersten Schritt erledigen" } } });
  });

  it("propagates an existing healthy path through nested backlog ancestors", () => {
    const input = snapshot({ projects: [
      { ...snapshot().projects[0]!, parentId: 20, hasViableProgressPath: true },
      { ...snapshot().projects[0]!, projectId: 20, title: "Oberprojekt", revision: 8, hasViableProgressPath: false },
    ] });
    const result = evaluateCommitmentTransition(input, "commitment", {
      resolution: resolution([5, 20]),
    });
    expect(result).toMatchObject({
      kind: "ready",
      plan: { projectActivations: [{ projectId: 5 }, { projectId: 20 }], nextAction: null },
    });
  });

  it.each([
    { hasHealthyFutureWaiting: true },
    { hasHealthyFutureRevisit: true },
  ])("accepts a healthy blocker or future revisit as a progress path", (healthyPath) => {
    const input = snapshot({ projects: [{ ...snapshot().projects[0]!, ...healthyPath }] });
    expect(evaluateCommitmentTransition(input, "commitment", { resolution: resolution([5]) })).toMatchObject({
      kind: "ready",
      plan: { nextAction: null },
    });
  });

  it("does not treat a deadline alone as a project progress path", () => {
    const result = evaluateCommitmentTransition(snapshot(), "commitment");
    expect(result).toMatchObject({ kind: "needs_decisions", decisionSnapshot: { projects: [{ required: ["progressPath"] }] } });
  });

  it("requires explicit reopening before adding a commitment to terminal work", () => {
    const input = snapshot({ subject: { ...snapshot().subject, status: "done", targetStatus: "actionable" } });
    expect(evaluateCommitmentTransition(input, "commitment")).toMatchObject({
      kind: "conflict", reason: "terminal_task_requires_reopen",
    });
    expect(evaluateCommitmentTransition({
      ...input,
      subject: { ...input.subject, explicitlyReopened: true },
    }, "commitment", { resolution: resolution([5], "Nächste Aktion") })).toMatchObject({ kind: "ready" });
  });

  it("distinguishes an omitted direct driver from an explicit null owner", () => {
    const projectSnapshot = snapshot({
      subject: {
        type: "project",
        id: 5,
        status: "backlog",
        targetStatus: "backlog",
        executionCommitment: true,
        newExecutionCommitment: true,
        revisitAt: null,
        recurring: false,
        explicitlyReopened: false,
      },
      projects: [{ ...snapshot().projects[0]!, hasViableProgressPath: true }],
    });
    expect(evaluateCommitmentTransition(projectSnapshot, "explicit_activation")).toMatchObject({
      kind: "ready",
      plan: { projectActivations: [{ projectId: 5, ownerMemberId: 1 }] },
    });
    expect(evaluateCommitmentTransition(projectSnapshot, "explicit_activation", { ownerMemberId: null })).toMatchObject({
      kind: "needs_decisions",
      decisionSnapshot: { projects: [{ projectId: 5, required: ["driver"] }] },
    });
  });
});

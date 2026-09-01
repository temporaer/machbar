import type { AcceptanceCriterion, Member, Tag, Task } from "@machbar/shared";
import type { ProjectWithActions, StuckProjectWithActions } from "../lib/api";
import { workflowActionsByStatus } from "../lib/projectWorkflow";

let idCounter = 1000;
function nextId() {
  idCounter += 1;
  return idCounter;
}

export function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: nextId(),
    name: "Alex",
    color: "#146356",
    pictureUrl: null,
    ...overrides,
  };
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: nextId(),
    name: "zuhause",
    color: "#2563eb",
    kind: "plain",
    groupingMode: "auto",
    sortPosition: null,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? nextId();
  const status =
    overrides.needsClarification === true &&
    (overrides.status === undefined || overrides.status === "actionable")
      ? "captured"
      : overrides.status ?? "actionable";
  return {
    id,
    revision: 1,
    projectId: null,
    parentTaskId: null,
    title: "Beispielaufgabe",
    notes: "",
    ownerMemberId: null,
    ownerInheritanceMode: "inherit",
    createdByMemberId: null,
    dueDate: null,
    scheduledDate: null,
    externalWait: null,
    priority: null,
    size: null,
    position: 0,
    completedAt: null,
    cancelledAt: null,
    repeatAfterDays: null,
    allowedDeviationDays: null,
    reminderAt: null,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    reviewedAt: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    effectiveTags: [],
    effectiveAreaTags: [],
    effectiveActorTags: [],
    effectiveContextTags: [],
    explicitTags: [],
    excludedTagIds: [],
    blocked: false,
    executable: status === "actionable",
    nextBlockerAttentionDate: null,
    blockers: [],
    dependencies: [],
    children: [],
    projectTitle: null,
    projectOwnerMemberId: null,
    projectDueDate: null,
    ...overrides,
    status,
    needsClarification: status === "captured",
  };
}

export function makeProject(overrides: Partial<ProjectWithActions> = {}): ProjectWithActions {
  const status = overrides.status ?? "active";
  const hasDriver = (overrides.ownerMemberId ?? null) !== null;
  const hasViableProgressPath = overrides.nextAction?.executable === true;
  return {
    id: nextId(),
    revision: 1,
    title: "Beispielprojekt",
    notes: "",
    status,
    ownerMemberId: null,
    dueDate: null,
    scheduledDate: null,
    position: 0,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    reviewedAt: null,
    tags: [],
    effectiveTags: [],
    effectiveAreaTags: [],
    primaryAreaTag: null,
    acceptanceCriteria: [],
    availableActions: workflowActionsByStatus[status],
    activationReadiness: {
      ready: hasDriver && hasViableProgressPath,
      hasDriver,
      hasViableProgressPath,
      hasHealthyFutureWaiting: false,
    },
    ...overrides,
  };
}

export function makeCriterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id: nextId(),
    projectId: 0,
    text: "Beispielkriterium",
    checked: false,
    position: 0,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    ...overrides,
  };
}

export function makeStuckProject(overrides: Partial<StuckProjectWithActions> = {}): StuckProjectWithActions {
  return {
    ...makeProject(),
    stuckReason: "no_next_action",
    ...overrides,
  };
}

import type { AcceptanceCriterion, Member, Tag, Task, WaitingGroup } from "@machbar/shared";
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
    projectId: null,
    parentTaskId: null,
    title: "Beispielaufgabe",
    notes: "",
    ownerMemberId: null,
    ownerInheritanceMode: "inherit",
    createdByMemberId: null,
    dueDate: null,
    scheduledDate: null,
    waitingFor: null,
    priority: null,
    size: null,
    position: 0,
    completedAt: null,
    cancelledAt: null,
    recurrenceRule: null,
    reminderAt: null,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    effectiveTags: [],
    effectiveAreaTags: [],
    effectiveActorTags: [],
    effectiveContextTags: [],
    explicitTags: [],
    excludedTagIds: [],
    blocked: false,
    dependencies: [],
    children: [],
    ...overrides,
    status,
    needsClarification: status === "captured",
  };
}

export function makeProject(overrides: Partial<ProjectWithActions> = {}): ProjectWithActions {
  const status = overrides.status ?? "active";
  return {
    id: nextId(),
    title: "Beispielprojekt",
    notes: "",
    status,
    ownerMemberId: null,
    dueDate: null,
    scheduledDate: null,
    position: 0,
    tags: [],
    effectiveTags: [],
    effectiveAreaTags: [],
    primaryAreaTag: null,
    acceptanceCriteria: [],
    availableActions: workflowActionsByStatus[status],
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
    repairAction: "Lege einen nächsten Schritt fest.",
    ...overrides,
  };
}

export function makeWaitingGroup(overrides: Partial<WaitingGroup> = {}): WaitingGroup {
  return { waitingFor: "Antwort von Steuerberater", tasks: [makeTask({ status: "waiting" })], ...overrides };
}

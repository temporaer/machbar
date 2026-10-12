import type {
  AcceptanceCriterion,
  Member,
  PhysicalContext,
  Tag,
  Task,
} from "@machbar/shared";
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

export function makePhysicalContext(
  overrides: Partial<PhysicalContext> = {},
): PhysicalContext {
  return {
    id: nextId(),
    source: "home_assistant",
    externalId: "zone.home",
    name: "Zuhause",
    active: true,
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
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
    kind: "action",
    ownerMemberId: null,
    ownerInheritanceMode: "inherit",
    contextInheritanceMode: "inherit",
    scope: "household",
    createdByMemberId: null,
    dueDate: null,
    scheduledDate: null,
    revisitAt: null,
    notBeforeAt: null,
    notBeforeDate: null,
    externalWait: null,
    priority: null,
    size: null,
    position: 0,
    completedAt: null,
    cancelledAt: null,
    repeatAfterDays: null,
    allowedDeviationDays: null,
    reminders: [],
    additionalNextAction: false,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    reviewedAt: null,
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    inheritedOwnerId: null,
    inheritedTags: [],
    effectiveTags: [],
    effectiveAreaTags: [],
    effectiveActorTags: [],
    explicitTags: [],
    excludedTagIds: [],
    explicitContexts: [],
    inheritedContexts: [],
    effectiveContexts: [],
    blocked: false,
    executable: status === "actionable",
    nextBlockerAttentionDate: null,
    blockers: [],
    acceptanceCriteria: [],
    dependencies: [],
    incomingDependencies: [],
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
  const project: ProjectWithActions = {
    id: nextId(),
    revision: 1,
    parentId: null,
    title: "Beispielprojekt",
    notes: "",
    status,
    archivedAt: status === "archived" ? new Date("2026-01-01T09:00:00Z").toISOString() : null,
    ownerMemberId: null,
    scope: "household",
    dueDate: null,
    scheduledDate: null,
    revisitAt: null,
    position: 0,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    reviewedAt: null,
    tags: [],
    contexts: [],
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
  const readiness = project.activationReadiness;
  return {
    ...project,
    activationReadiness: {
      ...readiness,
      requiredDecisions: readiness.requiredDecisions ?? [
        ...(!readiness.hasDriver ? ["driver" as const] : []),
        ...(!(readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting || readiness.hasHealthyFutureRevisit)
          ? ["progressPath" as const]
          : []),
      ],
    },
  };
}

export function makeCriterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id: nextId(),
    workItemId: overrides.workItemId ?? overrides.projectId ?? 0,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
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

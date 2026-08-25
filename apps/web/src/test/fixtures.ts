import type { Member, Project, StuckProject, Tag, Task, WaitingGroup } from "@machbar/shared";

let idCounter = 1000;
function nextId() {
  idCounter += 1;
  return idCounter;
}

export function makeMember(overrides: Partial<Member> = {}): Member {
  return { id: nextId(), name: "Alex", color: "#146356", ...overrides };
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return { id: nextId(), name: "zuhause", ...overrides };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? nextId();
  return {
    id,
    projectId: null,
    parentTaskId: null,
    title: "Beispielaufgabe",
    notes: "",
    status: "actionable",
    ownerMemberId: null,
    ownerInheritanceMode: "inherit",
    createdByMemberId: null,
    dueDate: null,
    scheduledDate: null,
    waitingFor: null,
    context: null,
    contextInheritanceMode: "inherit",
    priority: null,
    position: 0,
    markedToday: false,
    completedAt: null,
    cancelledAt: null,
    recurrenceRule: null,
    reminderAt: null,
    createdAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T09:00:00Z").toISOString(),
    effectiveOwnerId: null,
    effectiveOwnerSource: "none",
    effectiveContext: null,
    effectiveContextSource: "none",
    effectiveTags: [],
    explicitTags: [],
    excludedTagIds: [],
    blocked: false,
    dependencies: [],
    children: [],
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: nextId(),
    title: "Beispielprojekt",
    description: "",
    status: "active",
    ownerMemberId: null,
    context: null,
    dueDate: null,
    scheduledDate: null,
    position: 0,
    tags: [],
    ...overrides,
  };
}

export function makeStuckProject(overrides: Partial<StuckProject> = {}): StuckProject {
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

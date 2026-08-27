export const taskStatuses = [
  "captured",
  "actionable",
  "waiting",
  "someday",
  "done",
  "cancelled",
] as const;

export const projectStatuses = [
  "backlog",
  "active",
  "completed",
  "archived",
] as const;
export const inheritanceModes = ["inherit", "explicit", "none"] as const;
export const taskSizes = ["S", "M", "L", "XL"] as const;
export const tagKinds = ["area", "actor", "context", "plain"] as const;
export const tagGroupingModes = ["auto", "pinned", "hidden"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type InheritanceMode = (typeof inheritanceModes)[number];
export type TaskSize = (typeof taskSizes)[number];
export type TagKind = (typeof tagKinds)[number];
export type TagGroupingMode = (typeof tagGroupingModes)[number];

export interface Member {
  id: number;
  name: string;
  color: string;
  managedByOidc?: boolean;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  member: Member | null;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  kind: TagKind;
  groupingMode: TagGroupingMode;
  sortPosition: number | null;
}

export interface AcceptanceCriterion {
  id: number;
  projectId: number;
  text: string;
  checked: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  title: string;
  notes: string;
  status: ProjectStatus;
  ownerMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  position: number;
  tags: Tag[];
  effectiveTags: Tag[];
  effectiveAreaTags: Tag[];
  primaryAreaTag: Tag | null;
  acceptanceCriteria: AcceptanceCriterion[];
  openCount?: number;
  doneCount?: number;
  nextAction?: Task | null;
  stuckReason?: StuckReason | null;
  waitingOn?: string[];
  waitingUntil?: string | null;
  refinementIssues?: RefinementIssue[];
}

export interface Dependency {
  id: number;
  taskId: number;
  dependsOnTaskId: number;
  title?: string;
  resolved?: boolean;
}

export interface Task {
  id: number;
  projectId: number | null;
  parentTaskId: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  needsClarification: boolean;
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  createdByMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  waitingFor: string | null;
  priority: number | null;
  size: TaskSize | null;
  position: number;
  completedAt: string | null;
  cancelledAt: string | null;
  recurrenceRule: string | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  effectiveOwnerId: number | null;
  effectiveOwnerSource: "task" | "parent" | "project" | "none";
  effectiveTags: Tag[];
  effectiveAreaTags: Tag[];
  effectiveActorTags: Tag[];
  effectiveContextTags: Tag[];
  explicitTags: Tag[];
  excludedTagIds: number[];
  blocked: boolean;
  dependencies: Dependency[];
  children: Task[];
  projectTitle?: string | null;
  projectDueDate?: string | null;
}

export type StuckReason =
  | "no_next_action"
  | "only_waiting_without_followup"
  | "followup_due"
  | "blocked_dependencies"
  | "unassigned_actionable"
  // An `active` project whose tasks are all `done`/`cancelled`: it is not
  // "stuck" from a next-action standpoint, but it needs a human decision
  // (complete/reopen/archive) before it can move on.
  | "completion_review";

export interface StuckProject extends Project {
  stuckReason: StuckReason;
  repairAction: string;
}

export type ProjectAgendaQualification = "due" | "scheduled" | "both";

export interface ProjectAgendaEntry {
  project: Project;
  qualification: ProjectAgendaQualification;
  nextAction: Task | null;
  stuck: {
    reason: StuckReason;
    repairAction: string;
  } | null;
}

export interface Agenda {
  projects: ProjectAgendaEntry[];
  planned: Task[];
  overdue: Task[];
  dueToday: Task[];
  dueSoon: Task[];
  shared: Task[];
  unscheduled: Task[];
  /** Waiting tasks whose Wiedervorlage has arrived. */
  followUp: Task[];
  /**
   * Tasks that are normally excluded from "Heute" because they are
   * `blocked` (unresolved dependencies), but whose own `scheduledDate` is
   * today or earlier. These reappear here — and only here, never in any
   * other bucket — as a distinct "revisit"/reminder signal so the UI can
   * explain that the task is blocked yet due for a look today. Dates are
   * never inherited from a project or parent task for this purpose.
   */
  revisit: Task[];
}

export interface WaitingGroup {
  waitingFor: string;
  tasks: Task[];
}

export type RefinementIssueSeverity = "info" | "warning" | "urgent";

export type RefinementIssueCode =
  | "missing_driver"
  | "missing_outcome"
  | "missing_next_action"
  | "needs_clarification"
  | "unassigned_actionable"
  | "waiting_without_followup"
  | "followup_due"
  | "blocked_without_clear_path"
  | "due_without_plan"
  | "scheduled_in_past"
  | "too_large_without_children"
  | "completion_review";

export type RefinementActionCode =
  | "assign_driver"
  | "add_outcome"
  | "add_next_action"
  | "clarify_task"
  | "assign_task"
  | "set_followup"
  | "follow_up"
  | "resolve_blocker"
  | "plan_task"
  | "add_child"
  | "review_completion";

export interface RefinementAction {
  code: RefinementActionCode;
  label: string;
  targetTaskId?: number;
}

export interface RefinementIssue {
  code: RefinementIssueCode;
  severity: RefinementIssueSeverity;
  label: string;
  explanation: string;
  suggestedAction: RefinementAction;
  entityType: "project" | "task";
  entityId: number;
  entityTitle: string;
  projectId: number | null;
  projectTitle: string | null;
  dependencyPath?: Array<{ taskId: number; title: string }>;
}

export interface ProjectReadiness {
  projectId: number;
  ready: boolean;
  issues: RefinementIssue[];
}

export interface SearchFilters {
  text?: string;
  ownerId?: number;
  projectId?: number;
  tagIds?: number[];
  status?: TaskStatus;
  dueFrom?: string;
  dueTo?: string;
  scheduledFrom?: string;
  scheduledTo?: string;
  waitingFor?: string;
}

export const de = {
  appName: "Machbar",
  tagline: "Das ist machbar.",
  identity: "Wer bist du?",
  today: "Heute",
  inbox: "Eingang",
  projects: "Projekte",
  waiting: "Wartet",
  more: "Mehr",
  stuck: "Festgefahren",
  plannedToday: "Für heute geplant",
  overdue: "Überfällig",
  dueToday: "Heute fällig",
  dueSoon: "Bald fällig",
  shared: "Gemeinsam / offen",
  unscheduled: "Weitere machbare Aufgaben",
  followUp: "Nachhaken",
  followUpHint: "Die Wiedervorlage ist erreicht. Jetzt nachhaken oder die Aufgabe wieder machbar machen.",
  revisit: "Blockiert prüfen",
  revisitHint: "Blockiert, aber heute wieder zu prüfen.",
  nextAction: "Nächster Schritt",
  noNextAction: "Kein nächster Schritt",
  addTask: "Aufgabe hinzufügen",
  addSubtask: "Teilaufgabe hinzufügen",
  quickAdd: "Schnell hinzufügen",
  titleEnough: "Nur Titel reicht",
  save: "Speichern",
  cancel: "Abbrechen",
  discard: "Verwerfen",
  editTask: "Aufgabe bearbeiten",
  notes: "Notizen",
  owner: "Zuständig",
  status: "Status",
  due: "Fällig",
  scheduled: "Geplant",
  context: "Kontext",
  tags: "Tags",
  priority: "Priorität",
  dependencies: "Abhängigkeiten",
  subtasks: "Teilaufgaben",
  waitingFor: "Wartet auf",
  inherited: "Geerbt",
  inheritedProject: "Von Projekt geerbt",
  inheritedParent: "Von übergeordneter Aufgabe geerbt",
  ownOwner: "Eigene Zuständigkeit setzen",
  noContext: "Kein Kontext",
  actionable: "Machbar",
  someday: "Irgendwann",
  done: "Erledigt",
  cancelled: "Verworfen",
  clarify: "Klären",
  organize: "Sortieren",
  moveUp: "Nach oben",
  moveDown: "Nach unten",
  indent: "Einrücken",
  outdent: "Ausrücken",
  changeParent: "Übergeordnete Aufgabe ändern",
  moveProject: "In Projekt verschieben",
  moveSubtree: "Teilbaum verschieben",
  search: "Suchen",
  filter: "Filtern",
  noItems: "Hier ist gerade nichts zu tun.",
  saveNext: "Speichern & nächste klären",
  makeActionable: "Wieder machbar",
  blockedBy: "Blockiert durch",
  taskHasOpenChildren: "Diese Aufgabe hat offene Teilaufgaben.",
  onlyThisTask: "Nur diese Aufgabe erledigen",
  leaveChildrenOpen: "Teilaufgaben offen lassen",
  completeChildren: "Teilaufgaben ebenfalls erledigen",
  cancelChildren: "Teilaufgaben verwerfen",
} as const;

export const taskStatusLabels: Record<TaskStatus, string> = {
  captured: "Erfasst",
  actionable: "Machbar",
  waiting: "Wartet",
  someday: "Irgendwann",
  done: "Erledigt",
  cancelled: "Verworfen",
};

export const stuckReasonLabels: Record<StuckReason, string> = {
  no_next_action: "Kein nächster Schritt",
  only_waiting_without_followup: "Wartet ohne Wiedervorlage",
  followup_due: "Nachhaken fällig",
  blocked_dependencies: "Durch Abhängigkeiten blockiert",
  unassigned_actionable: "Offene Aufgabe ohne Zuständigkeit",
  completion_review: "Bereit zum Abschließen",
};

export const projectStatusLabels: Record<ProjectStatus, string> = {
  backlog: "Später / noch nicht aktiv",
  active: "Aktiv",
  completed: "Abgeschlossen",
  archived: "Archiviert",
};

export const taskSizeLabels: Record<TaskSize, string> = {
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
};

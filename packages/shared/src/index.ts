export const taskStatuses = [
  "inbox",
  "actionable",
  "waiting",
  "someday",
  "done",
  "cancelled",
] as const;

export const projectStatuses = ["active", "completed", "archived"] as const;
export const inheritanceModes = ["inherit", "explicit", "none"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type InheritanceMode = (typeof inheritanceModes)[number];

export interface Member {
  id: number;
  name: string;
  color: string;
}

export interface Tag {
  id: number;
  name: string;
}

export interface Project {
  id: number;
  title: string;
  description: string;
  status: ProjectStatus;
  ownerMemberId: number | null;
  context: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  position: number;
  tags: Tag[];
  openCount?: number;
  doneCount?: number;
  nextAction?: Task | null;
  stuckReason?: StuckReason | null;
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
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  createdByMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  waitingFor: string | null;
  context: string | null;
  contextInheritanceMode: InheritanceMode;
  priority: number | null;
  position: number;
  completedAt: string | null;
  cancelledAt: string | null;
  recurrenceRule: string | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  effectiveOwnerId: number | null;
  effectiveOwnerSource: "task" | "parent" | "project" | "none";
  effectiveContext: string | null;
  effectiveContextSource: "task" | "parent" | "project" | "none";
  effectiveTags: Tag[];
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
  | "only_waiting"
  | "blocked_dependencies"
  | "unassigned_actionable";

export interface StuckProject extends Project {
  stuckReason: StuckReason;
  repairAction: string;
}

export interface Agenda {
  planned: Task[];
  overdue: Task[];
  dueToday: Task[];
  dueSoon: Task[];
  shared: Task[];
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

export interface SearchFilters {
  text?: string;
  ownerId?: number;
  projectId?: number;
  effectiveContext?: string;
  explicitContext?: string;
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
  revisit: "Wiedervorlage",
  revisitHint: "Blockiert, aber zur Wiedervorlage für heute geplant.",
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
  followUp: "Nachhaken",
  makeActionable: "Wieder machbar",
  blockedBy: "Blockiert durch",
  taskHasOpenChildren: "Diese Aufgabe hat offene Teilaufgaben.",
  onlyThisTask: "Nur diese Aufgabe erledigen",
  leaveChildrenOpen: "Teilaufgaben offen lassen",
  completeChildren: "Teilaufgaben ebenfalls erledigen",
  cancelChildren: "Teilaufgaben verwerfen",
} as const;

export const taskStatusLabels: Record<TaskStatus, string> = {
  inbox: "Eingang",
  actionable: "Machbar",
  waiting: "Wartet",
  someday: "Irgendwann",
  done: "Erledigt",
  cancelled: "Verworfen",
};

export const stuckReasonLabels: Record<StuckReason, string> = {
  no_next_action: "Kein nächster Schritt",
  only_waiting: "Nur wartende Aufgaben",
  blocked_dependencies: "Durch Abhängigkeiten blockiert",
  unassigned_actionable: "Offene Aufgabe ohne Zuständigkeit",
};

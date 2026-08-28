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
export const activityEventKinds = [
  "task_created",
  "task_updated",
  "task_deleted",
  "task_status_changed",
  "task_descendants_status_changed",
  "task_moved",
  "task_dependencies_changed",
  "task_tags_changed",
  "project_created",
  "project_updated",
  "project_deleted",
  "project_status_changed",
  "project_tags_changed",
  "project_acceptance_criterion_added",
  "project_acceptance_criterion_updated",
  "project_acceptance_criterion_checked",
  "project_acceptance_criterion_removed",
] as const;
export const activityEntityTypes = ["task", "project"] as const;
export const contributionCategories = ["completion", "planning"] as const;
export const contributionReasons = [
  "task_completed",
  "project_completed",
  "task_clarified",
  "task_assigned",
  "task_estimated",
  "task_planned",
  "waiting_followup_added",
  "task_broken_down",
  "project_outcome_added",
  "project_driver_assigned",
  "project_next_action_added",
  "project_due_plan_added",
] as const;
export const ACTIVITY_ACTOR_HEADER = "x-machbar-actor-member-id";

export type TaskStatus = (typeof taskStatuses)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type InheritanceMode = (typeof inheritanceModes)[number];
export type TaskSize = (typeof taskSizes)[number];
export type TagKind = (typeof tagKinds)[number];
export type TagGroupingMode = (typeof tagGroupingModes)[number];
export type ActivityEventKind = (typeof activityEventKinds)[number];
export type ActivityEntityType = (typeof activityEntityTypes)[number];
export type ContributionCategory = (typeof contributionCategories)[number];
export type ContributionReason = (typeof contributionReasons)[number];
export type ContributionPulseLevel = "none" | "low" | "medium" | "high";

export type ApiErrorCode =
  | "acceptance_criteria_order_invalid"
  | "acceptance_criterion_not_found"
  | "acceptance_criterion_text_required"
  | "activity_actor_invalid"
  | "activity_actor_not_found"
  | "activity_cursor_invalid"
  | "activity_query_invalid"
  | "agenda_query_invalid"
  | "authentication_required"
  | "auth_return_target_invalid"
  | "auth_query_invalid"
  | "descendants_policy_required"
  | "internal_error"
  | "identifier_invalid"
  | "malformed_request"
  | "member_name_conflict"
  | "member_name_required"
  | "member_not_found"
  | "member_oidc_managed"
  | "oidc_callback_rejected"
  | "oidc_browser_mismatch"
  | "oidc_flow_expired"
  | "oidc_identity_orphaned"
  | "oidc_member_already_linked"
  | "oidc_name_conflict"
  | "oidc_name_missing"
  | "oidc_not_configured"
  | "oidc_provider_error"
  | "oidc_username_ambiguous"
  | "project_driver_locked"
  | "project_driver_required"
  | "project_not_found"
  | "project_title_required"
  | "project_transition_invalid"
  | "refinement_filters_invalid"
  | "request_body_invalid"
  | "request_origin_forbidden"
  | "route_not_found"
  | "search_query_invalid"
  | "tag_kind_conflict"
  | "tag_name_conflict"
  | "tag_name_required"
  | "tag_not_found"
  | "task_already_root"
  | "task_dependency_cycle"
  | "task_dependency_self"
  | "task_hierarchy_cycle"
  | "task_indent_unavailable"
  | "task_not_found"
  | "task_parent_self"
  | "task_sequence_too_short"
  | "task_title_required"
  | "waiting_query_invalid";

export interface ApiErrorPayload {
  code: ApiErrorCode;
  /** English fallback for logs and clients without localized error copy. */
  message: string;
  /** Translation parameters and machine-readable validation context. */
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiErrorPayload;
}

export interface ActivityEventMetadata {
  changedFields?: string[];
  previousStatus?: TaskStatus | ProjectStatus;
  nextStatus?: TaskStatus | ProjectStatus;
  checked?: boolean;
  affectedCount?: number;
  relatedTaskIds?: number[];
  relatedTaskTitles?: string[];
  relatedProjectIds?: number[];
  relatedProjectTitles?: string[];
}

export interface ActivityActor {
  id: number;
  name: string;
  color: string;
  pictureUrl: string | null;
}

export interface ActivityEntity {
  type: ActivityEntityType;
  title: string;
  taskId: number | null;
  projectId: number | null;
}

export interface ActivityEvent {
  id: number;
  createdAt: string;
  kind: ActivityEventKind;
  actor: ActivityActor | null;
  entity: ActivityEntity;
  metadata: ActivityEventMetadata;
}

export interface ActivityPage {
  items: ActivityEvent[];
  nextCursor: string | null;
}

export interface ContributionCategoryTotals {
  completion: number;
  planning: number;
}

export interface MemberContributionSummary {
  member: ActivityActor;
  total: number;
  categories: ContributionCategoryTotals;
}

export interface ContributionPulseBucket {
  startedAt: string;
  endedAt: string;
  level: ContributionPulseLevel;
}

export interface ContributionSummary {
  windowStartedAt: string;
  windowEndedAt: string;
  sharedTotal: number;
  sharedOnlyTotal: number;
  sharedCategories: ContributionCategoryTotals;
  members: MemberContributionSummary[];
  pulse: ContributionPulseBucket[];
}

export interface Member {
  id: number;
  name: string;
  color: string;
  pictureUrl: string | null;
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
}

export type ProjectAgendaQualification = "due" | "scheduled" | "both";

export interface ProjectAgendaEntry {
  project: Project;
  qualification: ProjectAgendaQualification;
  nextAction: Task | null;
  stuck: {
    reason: StuckReason;
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
  /** Null when the task has no explicit waiting-for description. */
  waitingFor: string | null;
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
  targetTaskId?: number;
}

export type RefinementBlockingReason =
  | "captured"
  | "waiting"
  | "someday"
  | "terminal_project"
  | "cycle";

export interface RefinementIssue {
  code: RefinementIssueCode;
  severity: RefinementIssueSeverity;
  suggestedAction: RefinementAction;
  entityType: "project" | "task";
  entityId: number;
  entityTitle: string;
  projectId: number | null;
  projectTitle: string | null;
  blockingReason?: RefinementBlockingReason;
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

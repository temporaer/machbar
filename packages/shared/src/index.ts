export const taskStatuses = [
  "captured",
  "actionable",
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
export const tagKinds = ["area", "actor", "plain"] as const;
export const tagGroupingModes = ["auto", "pinned", "hidden"] as const;
export const activityEventKinds = [
  "task_created",
  "task_updated",
  "task_deleted",
  "task_status_changed",
  "task_descendants_status_changed",
  "task_moved",
  "task_dependencies_changed",
  "task_external_wait_started",
  "task_external_wait_updated",
  "task_external_wait_resolved",
  "task_tags_changed",
  "task_contexts_changed",
  "project_created",
  "project_updated",
  "project_deleted",
  "project_status_changed",
  "project_tags_changed",
  "project_contexts_changed",
  "project_acceptance_criterion_added",
  "project_acceptance_criterion_updated",
  "project_acceptance_criterion_checked",
  "project_acceptance_criterion_removed",
] as const;
export const activityEntityTypes = ["task", "project"] as const;
export const contributionCategories = ["completion", "planning"] as const;
export const contributionReasons = [
  "task_completed",
  "recurrence_missed",
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
export const notificationKinds = [
  "task_assigned",
  "project_assigned",
  "task_reminder",
  "context_entered",
] as const;
export const pushNotificationPreferenceKinds = [
  "project_assigned",
  "task_reminder",
  "context_entered",
] as const;
export const notificationEntityTypes = ["task", "project"] as const;
export const pushLocales = ["de", "en"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type InheritanceMode = (typeof inheritanceModes)[number];
export type TaskSize = (typeof taskSizes)[number];
export type TagKind = (typeof tagKinds)[number];
export type TagGroupingMode = (typeof tagGroupingModes)[number];
export type ActivityEventKind = (typeof activityEventKinds)[number];
export type ActivityEntityType = (typeof activityEntityTypes)[number];
export type ContributionEntityType = ActivityEntityType | "task_occurrence";
export type ContributionCategory = (typeof contributionCategories)[number];
export type ContributionReason = (typeof contributionReasons)[number];
export type NotificationKind = (typeof notificationKinds)[number];
export type PushNotificationPreferenceKind =
  (typeof pushNotificationPreferenceKinds)[number];
export type NotificationEntityType = (typeof notificationEntityTypes)[number];
export type PushLocale = (typeof pushLocales)[number];
export type ContributionPulseLevel =
  | "negative"
  | "none"
  | "low"
  | "medium"
  | "high";

export type ApiErrorCode =
  | "acceptance_criteria_order_invalid"
  | "acceptance_criterion_not_found"
  | "acceptance_criterion_text_required"
  | "activity_actor_invalid"
  | "activity_actor_not_found"
  | "activity_cursor_invalid"
  | "activity_query_invalid"
  | "agenda_query_invalid"
  | "contribution_query_invalid"
  | "authentication_required"
  | "auth_return_target_invalid"
  | "auth_query_invalid"
  | "descendants_policy_required"
  | "external_wait_recurring_forbidden"
  | "external_wait_status_invalid"
  | "internal_error"
  | "integration_authentication_required"
  | "integration_token_revoked"
  | "identifier_invalid"
  | "malformed_request"
  | "member_active_projects_conflict"
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
  | "paperless_authentication_failed"
  | "paperless_document_not_found"
  | "paperless_file_too_large"
  | "paperless_not_configured"
  | "paperless_processing_timeout"
  | "paperless_query_invalid"
  | "paperless_response_invalid"
  | "paperless_unavailable"
  | "paperless_upload_rejected"
  | "pairing_code_expired"
  | "pairing_code_invalid"
  | "pairing_code_used"
  | "physical_context_not_found"
  | "project_driver_locked"
  | "project_driver_required"
  | "project_activation_not_ready"
  | "project_completion_criteria_incomplete"
  | "project_not_found"
  | "project_title_required"
  | "project_transition_invalid"
  | "push_member_required"
  | "push_not_configured"
  | "push_subscription_missing"
  | "refinement_filters_invalid"
  | "request_body_invalid"
  | "request_origin_forbidden"
  | "recurrence_configuration_invalid"
  | "recurrence_completion_date_required"
  | "recurrence_completion_revision_required"
  | "recurring_descendant_completion_required"
  | "recurring_parent_forbidden"
  | "recurring_task_leaf_required"
  | "recurring_task_scheduled_required"
  | "route_not_found"
  | "search_query_invalid"
  | "stale_write_conflict"
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
  | "task_promotion_invalid"
  | "task_sequence_too_short"
  | "task_title_required"
  | "external_wait_reason_required"
  | "waiting_query_invalid"
  | "unsupported_protocol_version";

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

export interface PaperlessDocumentSummary {
  id: number;
  title: string;
  originalFileName: string;
  mimeType: string | null;
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
  recurrenceOccurrenceId?: number;
  recurrenceResult?: RecurrenceOccurrenceResult;
  occurrenceScheduledDate?: string;
  occurrenceDeadlineDate?: string;
  occurrenceCompletedOn?: string;
  nextScheduledDate?: string;
  nextDeadlineDate?: string;
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

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export type PushNotificationPreferences = Record<
  PushNotificationPreferenceKind,
  boolean
>;

export interface PushSubscriptionRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: PushLocale;
  timezone?: string | null;
}

export interface PushSubscriptionRemoval {
  endpoint: string;
}

export type PushNotificationAction = "today" | "open" | "complete";

export interface PushNotificationPayload {
  version: 1;
  kind: NotificationKind | "test";
  title: string;
  body: string;
  tag: string;
  entity: {
    type: NotificationEntityType;
    id: number;
  } | null;
  recipientMemberId: number;
  actions: Array<{
    action: PushNotificationAction;
    title: string;
  }>;
  taskRevision?: number;
  recurringTask?: boolean;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  kind: TagKind;
  groupingMode: TagGroupingMode;
  sortPosition: number | null;
}

export interface PhysicalContext {
  id: number;
  source: "home_assistant";
  externalId: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

export type ContextAvailabilityStatus =
  | "available"
  | "unavailable"
  | "unknown";

export interface ContextAvailability {
  status: ContextAvailabilityStatus;
  availableNow: boolean;
  missingContexts: PhysicalContext[];
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

export interface ProjectActivationReadiness {
  ready: boolean;
  hasDriver: boolean;
  hasViableProgressPath: boolean;
  hasHealthyFutureWaiting: boolean;
}

export interface Project {
  id: number;
  revision: number;
  title: string;
  notes: string;
  status: ProjectStatus;
  ownerMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  tags: Tag[];
  contexts: PhysicalContext[];
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
}

export interface Dependency {
  id: number;
  taskId: number;
  dependsOnTaskId: number;
  title?: string;
  resolved?: boolean;
}

export interface ExternalWait {
  waitingFor: string | null;
  revisitDate: string | null;
}

export type TaskBlockerSummary =
  | {
      type: "external";
      waitingFor: string | null;
    }
  | {
      type: "dependency";
      taskId: number;
      title?: string;
      scheduledDate?: string | null;
      resolved: boolean;
    };

export interface Task {
  id: number;
  revision: number;
  projectId: number | null;
  parentTaskId: number | null;
  title: string;
  notes: string;
  status: TaskStatus;
  needsClarification: boolean;
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  contextInheritanceMode: InheritanceMode;
  createdByMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  externalWait: ExternalWait | null;
  priority: number | null;
  size: TaskSize | null;
  position: number;
  completedAt: string | null;
  cancelledAt: string | null;
  repeatAfterDays: number | null;
  allowedDeviationDays: number | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  effectiveOwnerId: number | null;
  effectiveOwnerSource: "task" | "parent" | "project" | "none";
  inheritedOwnerId: number | null;
  effectiveTags: Tag[];
  effectiveAreaTags: Tag[];
  effectiveActorTags: Tag[];
  explicitTags: Tag[];
  excludedTagIds: number[];
  explicitContexts: PhysicalContext[];
  inheritedContexts: PhysicalContext[];
  effectiveContexts: PhysicalContext[];
  blocked: boolean;
  executable: boolean;
  nextBlockerAttentionDate: string | null;
  blockers: TaskBlockerSummary[];
  dependencies: Dependency[];
  children: Task[];
  projectTitle?: string | null;
  projectOwnerMemberId?: number | null;
  projectDueDate?: string | null;
}

export type RecurrenceOccurrenceResult = "hit" | "miss";

export interface TaskRecurrenceConfig {
  repeatAfterDays: number;
  allowedDeviationDays: number;
}

export interface TaskRecurrenceOccurrence {
  id: number;
  taskId: number;
  scheduledDate: string;
  deadlineDate: string;
  completedOn: string;
  completedAt: string;
  result: RecurrenceOccurrenceResult;
}

export interface TaskRecurrenceSummary {
  hitCount: number;
  missCount: number;
  totalCount: number;
  hitRate: number | null;
}

export interface TaskRecurrenceHistory {
  summary: TaskRecurrenceSummary;
  occurrences: TaskRecurrenceOccurrence[];
}

export type StuckReason =
  | "no_next_action"
  | "waiting_without_followup"
  | "blocked_without_clear_path"
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
  nextActionContextAvailability: ContextAvailability | null;
  stuck: {
    reason: StuckReason;
  } | null;
}

export type WaitingReason =
  | {
      type: "external";
      waitingFor: string | null;
      revisitDate: string | null;
    }
  | {
      type: "context";
      contexts: PhysicalContext[];
    };

export interface WaitingEntry {
  task: Task;
  reasons: WaitingReason[];
}

export interface HomeAssistantPerson {
  externalId: string;
  name: string;
  state: "known" | "unknown";
  contexts: PhysicalContext[];
  mappedMemberId: number | null;
  observedAt: string;
}

export interface HomeAssistantIntegrationStatus {
  connected: boolean;
  instanceId: string | null;
  protocolVersion: number | null;
  connectedAt: string | null;
  lastUpdateAt: string | null;
  stale: boolean;
  contexts: PhysicalContext[];
  people: HomeAssistantPerson[];
}

export interface HomeAssistantPairingCode {
  code: string;
  expiresAt: string;
}

export interface HomeAssistantPairingResponse {
  token: string;
  instanceId: string;
  protocolVersion: 1;
}

export interface HomeAssistantContextSnapshot {
  protocolVersion: 1;
  observedAt: string;
  contexts: Array<{
    externalId: string;
    name: string;
  }>;
  people: Array<{
    externalId: string;
    name: string;
    state: "known" | "unknown";
    contexts: string[];
  }>;
}

export interface Agenda {
  projects: ProjectAgendaEntry[];
  planned: Task[];
  overdue: Task[];
  dueToday: Task[];
  dueSoon: Task[];
  shared: Task[];
  unscheduled: Task[];
  /**
   * Tasks with a direct external wait whose `revisitDate` is today or earlier.
   * They reappear here as an attention signal even though they remain blocked.
   */
  revisit: Task[];
}

export interface MoreCounts {
  review: number;
}

export interface GraphLoadMetrics {
  totalLoads: number;
  recentSamples: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  lastTaskCount: number | null;
  lastProjectCount: number | null;
}

export interface DebugMetrics {
  generatedAt: string;
  processStartedAt: string;
  processUptimeSeconds: number;
  database: {
    allocatedBytes: number;
    usedBytes: number;
    pageSizeBytes: number;
    pageCount: number;
    freelistPages: number;
    counts: {
      members: number;
      projects: number;
      tasks: number;
      tags: number;
      dependencies: number;
      externalWaits: number;
      activityEvents: number;
      contributionEvents: number;
    };
    taskStatusCounts: Record<TaskStatus, number>;
    projectStatusCounts: Record<ProjectStatus, number>;
    maxTaskDepth: number;
    tasksCreatedToday: number;
    tasksCreatedLast7Days: number;
    activityEventsCreatedLast7Days: number;
  };
  graphLoads: GraphLoadMetrics;
}

export type ReviewCategory =
  | "clarification_repair"
  | "reconsider"
  | "completion";

export type ReviewReason =
  | "missing_driver"
  | "no_viable_progress_path"
  | "waiting_without_followup"
  | "broken_blocker_path"
  | "xl_without_children"
  | "completion_review"
  | "active_stale"
  | "backlog_stale"
  | "backlog_due"
  | "standalone_someday_stale";

export type ReviewActionCode =
  | "assign_driver"
  | "add_next_action"
  | "set_followup"
  | "resolve_blocker"
  | "add_child"
  | "review_completion"
  | "review_project"
  | "review_task";

export interface ReviewAction {
  code: ReviewActionCode;
  targetEntityType?: "project" | "task";
  targetEntityId?: number;
}

export interface ReviewItem {
  entityType: "project" | "task";
  entityId: number;
  entityTitle: string;
  projectId: number | null;
  projectTitle: string | null;
  category: ReviewCategory;
  reason: ReviewReason;
  suggestedAction: ReviewAction;
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
  blocked?: boolean;
  externalWait?: boolean;
}

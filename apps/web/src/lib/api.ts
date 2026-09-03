import { ACTIVITY_ACTOR_HEADER } from "@machbar/shared";
import type {
  ActivityPage,
  Agenda,
  ApiErrorCode,
  ApiErrorResponse,
  AuthStatus,
  ContributionSummary,
  DebugMetrics,
  HomeAssistantIntegrationStatus,
  HomeAssistantPairingCode,
  InheritanceMode,
  Member,
  MoreCounts,
  PaperlessDocumentSummary,
  Project,
  ProjectActivationReadiness,
  ProjectAgendaEntry,
  ProjectStatus,
  PushConfig,
  PushNotificationPreferences,
  PushSubscriptionRegistration,
  ReviewItem,
  SearchFilters,
  StuckProject,
  Tag,
  TagGroupingMode,
  TagKind,
  Task,
  TaskRecurrenceHistory,
  TaskSize,
  TaskStatus,
  WaitingEntry,
} from "@machbar/shared";
import { readRequestActorMemberId } from "./identityStorage";
import { getClientId } from "./clientId";

/**
 * The real `apps/api` backend (see `apps/api/src/app.ts` / `static.ts`)
 * always mounts its JSON routes at the absolute path `/api/...`, no
 * matter which `BASE_PATH` the built web app is served from — only the
 * static assets/index.html move under a configurable sub-path prefix.
 * So the frontend's own asset URLs stay relative (`vite.config.ts` sets
 * `base: './'`, and we use a `HashRouter` so client-side routes never
 * change the document path), but API calls must use an absolute `/api`
 * path to reach the backend under any Ingress prefix.
 */
const API_ROOT = "/api";
export const changeStreamUrl = () =>
  `${API_ROOT}/changes?clientId=${encodeURIComponent(getClientId())}`;

function selectedActorHeader(method = "GET"): Record<string, string> {
  if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") {
    return {};
  }
  const memberId = readRequestActorMemberId();
  return memberId === null
    ? {}
    : { [ACTIVITY_ACTOR_HEADER]: String(memberId) };
}

function clientHeader(method = "GET"): Record<string, string> {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD"
    ? {}
    : { "X-Machbar-Client-Id": getClientId() };
}

export class ApiError extends Error {
  status: number;
  code?: ApiErrorCode | undefined;
  details?: Record<string, unknown> | undefined;
  constructor(
    status: number,
    message: string,
    code?: ApiErrorCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "ApiError";
  }
}

/**
 * Only defaults `Content-Type: application/json` when the request actually
 * carries a body. Fastify's JSON body parser raises `FST_ERR_CTP_EMPTY_JSON_BODY`
 * (a 400) whenever it sees that content type on a bodyless request — which
 * every bodyless `DELETE` call (e.g. `deleteMember`/`deleteTask`) used to
 * trigger, since this header was previously sent unconditionally. Any header
 * explicitly supplied by the caller (via `init.headers`) still wins, since it
 * is spread in after this default.
 */
export type ApiResponseType = "json" | "blob";

export async function request<T>(
  path: string,
  init?: RequestInit,
  responseType: ApiResponseType = "json",
): Promise<T> {
  const url = `${API_ROOT}${path}`;
  const isFormData =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined && !isFormData
        ? { "Content-Type": "application/json" }
        : {}),
      ...selectedActorHeader(init?.method),
      ...clientHeader(init?.method),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("machbar:authentication-required"));
    }
    let message = res.statusText;
    let code: ApiErrorCode | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as Partial<ApiErrorResponse>;
      if (body?.error?.message) message = body.error.message;
      code = body?.error?.code;
      details = body?.error?.details;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new ApiError(res.status, message || "Request failed", code, details);
  }
  if (res.status === 204) return undefined as T;
  if (responseType === "blob") return (await res.blob()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function query(
  params: Record<string, string | number | boolean | undefined | null | number[]>,
) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) usp.set(key, value.join(","));
    } else {
      usp.set(key, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/** Matches the transactional task lifecycle policy accepted by complete/cancel. */
export type TaskDescendantsPolicy =
  | "leave_open"
  | "complete_children"
  | "cancel_children";

export interface MoveTaskInput {
  parentTaskId?: number | null;
  projectId?: number | null;
  position?: number;
  expectedRevision: number;
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  needsClarification?: boolean;
  projectId?: number | null;
  parentTaskId?: number | null;
  status?: TaskStatus;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  priority?: number | null;
  size?: TaskSize | null;
  repeatAfterDays?: number | null;
  allowedDeviationDays?: number | null;
  reminderAt?: string | null;
  tagIds?: number[];
  contextIds?: number[];
  contextInheritanceMode?: InheritanceMode;
}

/** Body for `POST /api/tasks/:id/children` (no `projectId`/`parentTaskId`, both implied). */
export type CreateChildTaskInput = Omit<CreateTaskInput, "projectId" | "parentTaskId">;

export interface CreateTaskSequenceInput {
  titles: string[];
  createdByMemberId?: number | null;
}

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "parentTaskId" | "projectId">> & {
  excludedTagIds?: number[];
  expectedRevision?: number;
  completedOn?: string;
};

export interface PromoteTaskToProjectInput {
  status: "active" | "backlog";
  title?: string;
  notes?: string;
  expectedRevision?: number;
}

/**
 * Project notes hold free-form context independently from the structured
 * "Erledigt, wenn …" checklist.
 */
export interface CreateProjectInput {
  title: string;
  notes?: string;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  tagIds?: number[];
  contextIds?: number[];
}

export type UpdateProjectInput = Partial<CreateProjectInput> & {
  position?: number;
  expectedRevision?: number;
};

/** Matches `apps/api/src/domain/mutations.ts::ProjectWorkflowAction`. */
export type ProjectWorkflowAction =
  | "activate"
  | "return_to_backlog"
  | "complete"
  | "reopen"
  | "archive";

/**
 * Every project/story API response carries `availableActions` (see
 * `apps/api/src/domain/graph.ts::ProjectRecord`) alongside the shared
 * `Project`/`StuckProject` fields — the single source of truth for which
 * lifecycle transitions are currently legal, so the UI never has to
 * reimplement the backlog/active/completed/archived state machine itself.
 */
export type ProjectWithActions = Project & {
  availableActions: ProjectWorkflowAction[];
  activationReadiness: ProjectActivationReadiness;
};
export type StuckProjectWithActions = StuckProject & {
  availableActions: ProjectWorkflowAction[];
  activationReadiness: ProjectActivationReadiness;
};
export type ProjectDetail = ProjectWithActions & { tasks: Task[] };

/** Body for `POST /api/projects/:id/activate` (matches `activateProjectSchema`). */
export interface ProjectWorkflowInput {
  expectedRevision: number;
}

export interface ActivateProjectInput extends ProjectWorkflowInput {
  ownerMemberId?: number | null;
}

/**
 * Owner×size aggregation row for the refinement matrix (see
 * `apps/api/src/repo/refinementRepo.ts::OwnerSizeCounts`). `ownerId: null`
 * is the shared/unassigned bucket.
 */
export interface OwnerSizeCounts {
  ownerId: number | null;
  ownerName: string | null;
  S: number;
  M: number;
  L: number;
  XL: number;
  unestimated: number;
  total: number;
}

/** Matches `apps/api/src/repo/refinementRepo.ts::RefinementTaskRow`. */
export interface RefinementTaskRow {
  id: number;
  revision: number;
  title: string;
  status: TaskStatus;
  size: TaskSize | null;
  projectId: number | null;
  projectTitle: string | null;
  effectiveOwnerId: number | null;
  effectiveOwnerSource: "task" | "parent" | "project" | "none";
  position: number;
  updatedAt: string;
  blocked: boolean;
  executable: boolean;
  externalWait: Task["externalWait"];
  nextBlockerAttentionDate: string | null;
  blockers: Task["blockers"];
  dependencies: Task["dependencies"];
  effectiveTags: Tag[];
}

export interface ExternalWaitInput {
  waitingFor?: string | null;
  revisitDate?: string | null;
  expectedRevision?: number;
}

export type ExternalWaitFollowUpInput =
  | {
      action: "resolve";
      content: string;
      expectedRevision: number;
    }
  | {
      action: "continue";
      content: string;
      waitingFor?: string | null;
      revisitDate?: string | null;
      expectedRevision: number;
    };

/** Matches `apps/api/src/routes/refinement.ts`'s query params. */
export interface RefinementFilters {
  /** A positive member id, or the literal `"none"` for the shared/unassigned bucket. */
  ownerId?: number | "none";
  projectId?: number;
  tagIds?: number[];
}

export interface ActivityFilters {
  cursor?: string;
  limit?: number;
  actorId?: number;
  taskId?: number;
  projectId?: number;
}

export type { ActivityEvent, ActivityPage } from "@machbar/shared";

export interface UpdateTagInput {
  name?: string;
  kind?: TagKind;
  groupingMode?: TagGroupingMode;
  sortPosition?: number | null;
}

export interface CreateMemberInput {
  name: string;
}

export type UpdateMemberInput = Partial<CreateMemberInput>;

export type AgendaResponse = Agenda & {
  followUp?: Task[];
};

export type AgendaScope = "mine" | "all";

export type { ProjectAgendaEntry };

const paperlessDocumentsPath = "/integrations/paperless/documents";

export function paperlessDocumentThumbnailUrl(id: number): string {
  return `${API_ROOT}${paperlessDocumentsPath}/${id}/thumbnail`;
}

export function paperlessDocumentPreviewUrl(id: number): string {
  return `${API_ROOT}${paperlessDocumentsPath}/${id}/preview`;
}

export function paperlessDocumentDownloadUrl(id: number): string {
  return `${API_ROOT}${paperlessDocumentsPath}/${id}/download`;
}

export const api = {
  getAuthStatus: () => request<AuthStatus>("/auth/status"),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  getPushConfig: () => request<PushConfig>("/push/config"),
  getPushNotificationPreferences: () =>
    request<PushNotificationPreferences>("/push/preferences"),
  updatePushNotificationPreferences: (input: PushNotificationPreferences) =>
    request<PushNotificationPreferences>("/push/preferences", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  registerPushSubscription: (input: PushSubscriptionRegistration) =>
    request<void>("/push/subscription", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  unregisterPushSubscription: (endpoint: string) =>
    request<void>("/push/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
  sendTestPushNotification: (endpoint: string) =>
    request<void>("/push/test", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
  uploadPaperlessDocument: (file: File) => {
    const body = new FormData();
    body.append("document", file, file.name);
    return request<PaperlessDocumentSummary>(paperlessDocumentsPath, {
      method: "POST",
      body,
    });
  },
  preparePaperlessImageForCrop: (file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.append("document", file, file.name);
    return request<Blob>(
      `${paperlessDocumentsPath}/prepare-image`,
      { method: "POST", body, ...(signal ? { signal } : {}) },
      "blob",
    );
  },
  searchPaperlessDocuments: (search: string) =>
    request<PaperlessDocumentSummary[]>(
      `${paperlessDocumentsPath}${query({ query: search })}`,
    ),
  getPaperlessDocumentPreview: (id: number) =>
    request<Blob>(`${paperlessDocumentsPath}/${id}/preview`, undefined, "blob"),

  getMembers: () => request<Member[]>("/members"),
  createMember: (input: CreateMemberInput) =>
    request<Member>("/members", { method: "POST", body: JSON.stringify(input) }),
  updateMember: (id: number, patch: UpdateMemberInput) =>
    request<Member>(`/members/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMember: (id: number) => request<void>(`/members/${id}`, { method: "DELETE" }),

  getTags: () => request<Tag[]>("/tags"),
  createTag: (name: string, kind: TagKind = "plain") =>
    request<Tag>("/tags", { method: "POST", body: JSON.stringify({ name, kind }) }),
  updateTag: (id: number, patch: UpdateTagInput) =>
    request<Tag>(`/tags/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTag: (id: number) => request<void>(`/tags/${id}`, { method: "DELETE" }),

  getProjects: () => request<ProjectWithActions[]>("/projects"),
  getProject: (id: number) => request<ProjectDetail>(`/projects/${id}`),
  createProject: (input: CreateProjectInput) =>
    request<ProjectWithActions>("/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (id: number, patch: UpdateProjectInput) =>
    request<ProjectWithActions>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  appendProjectNotes: (id: number, content: string) =>
    request<ProjectWithActions>(`/projects/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteProject: (id: number) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),

  // --- explicit workflow transitions (see `ProjectWorkflowAction` above) --
  activateProject: (id: number, input?: ActivateProjectInput) =>
    request<ProjectWithActions>(`/projects/${id}/activate`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  returnProjectToBacklog: (id: number, input: ProjectWorkflowInput) =>
    request<ProjectWithActions>(`/projects/${id}/return-to-backlog`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  completeProject: (id: number, input: ProjectWorkflowInput) =>
    request<ProjectWithActions>(`/projects/${id}/complete`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopenProject: (id: number, input: ActivateProjectInput) =>
    request<ProjectWithActions>(`/projects/${id}/reopen`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  archiveProject: (id: number, input: ProjectWorkflowInput) =>
    request<ProjectWithActions>(`/projects/${id}/archive`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  acknowledgeProjectReview: (id: number, input: ProjectWorkflowInput) =>
    request<ProjectWithActions>(`/projects/${id}/review`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // --- acceptance criteria (ordered, structured; replaces free-text description) ---
  addCriterion: (projectId: number, text: string) =>
    request<ProjectWithActions>(`/projects/${projectId}/criteria`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  updateCriterion: (projectId: number, criterionId: number, text: string) =>
    request<ProjectWithActions>(`/projects/${projectId}/criteria/${criterionId}`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),
  checkCriterion: (projectId: number, criterionId: number, checked: boolean) =>
    request<ProjectWithActions>(`/projects/${projectId}/criteria/${criterionId}/check`, {
      method: "POST",
      body: JSON.stringify({ checked }),
    }),
  reorderCriteria: (projectId: number, orderedCriterionIds: number[]) =>
    request<ProjectWithActions>(`/projects/${projectId}/criteria/reorder`, {
      method: "POST",
      body: JSON.stringify({ orderedCriterionIds }),
    }),
  removeCriterion: (projectId: number, criterionId: number) =>
    request<ProjectWithActions>(`/projects/${projectId}/criteria/${criterionId}`, {
      method: "DELETE",
    }),

  // --- refinement (owner×size matrix + task list; see `apps/api/src/routes/refinement.ts`) ---
  getRefinementOwners: (filters?: RefinementFilters) =>
    request<OwnerSizeCounts[]>(
      `/refinement/owners${query({ ownerId: filters?.ownerId, projectId: filters?.projectId, tagIds: filters?.tagIds })}`,
    ),
  getRefinementTasks: (filters?: RefinementFilters) =>
    request<RefinementTaskRow[]>(
      `/refinement/tasks${query({ ownerId: filters?.ownerId, projectId: filters?.projectId, tagIds: filters?.tagIds })}`,
    ),
  getReviewItems: () => request<ReviewItem[]>("/review"),
  getMoreCounts: () =>
    request<MoreCounts>("/views/more-counts"),

  getActivity: (filters?: ActivityFilters) =>
    request<ActivityPage>(
      `/activity${query({
        cursor: filters?.cursor,
        limit: filters?.limit,
        actorId: filters?.actorId,
        taskId: filters?.taskId,
        projectId: filters?.projectId,
      })}`,
    ),

  getContributionSummary: () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return request<ContributionSummary>(
      `/contributions/summary?timezone=${encodeURIComponent(timezone)}`,
    );
  },

  getDebugMetrics: () => request<DebugMetrics>("/debug/metrics"),

  /**
   * `mine` scopes the agenda to the current member plus shared work.
   * `all` deliberately omits `memberId` and asks for the whole household
   * agenda. This only changes the read projection; mutation actor identity
   * remains session/header-bound elsewhere in the client and API.
   */
  getAgenda: (
    memberId?: number | null,
    scope: AgendaScope = "mine",
  ) => {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    return request<AgendaResponse>(
      `/agenda/today${query({
        memberId: scope === "mine" ? memberId : undefined,
        scope,
        date,
      })}`,
    );
  },
  getInbox: () => request<Task[]>("/inbox"),
  getWaiting: (memberId?: number | null, scope: AgendaScope = "mine") =>
    request<WaitingEntry[]>(
      `/waiting${query({
        memberId: scope === "mine" ? memberId : undefined,
        scope,
      })}`,
    ),
  getHomeAssistantStatus: () =>
    request<HomeAssistantIntegrationStatus>(
      "/integrations/home-assistant/status",
    ),
  createHomeAssistantPairingCode: () =>
    request<HomeAssistantPairingCode>(
      "/integrations/home-assistant/pairing-code",
      { method: "POST" },
    ),
  revokeHomeAssistant: () =>
    request<void>("/integrations/home-assistant/connection", {
      method: "DELETE",
    }),
  setHomeAssistantMemberMapping: (
    externalId: string,
    memberId: number | null,
  ) =>
    request<void>(
      `/integrations/home-assistant/people/${encodeURIComponent(externalId)}/mapping`,
      { method: "PUT", body: JSON.stringify({ memberId }) },
    ),
  searchTasks: (filters: SearchFilters) =>
    request<Task[]>(
      `/search${query({
        text: filters.text,
        ownerId: filters.ownerId,
        projectId: filters.projectId,
        tagIds: filters.tagIds,
        status: filters.status,
        dueFrom: filters.dueFrom,
        dueTo: filters.dueTo,
        scheduledFrom: filters.scheduledFrom,
        scheduledTo: filters.scheduledTo,
        blocked: filters.blocked,
        externalWait: filters.externalWait,
      })}`,
    ),

  getTask: (id: number) => request<Task>(`/tasks/${id}`),
  acknowledgeTaskReview: (id: number, expectedRevision: number) =>
    request<Task>(`/tasks/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }),
  getTaskRecurrenceHistory: (id: number) =>
    request<TaskRecurrenceHistory>(`/tasks/${id}/recurrence-history`),
  createTask: (input: CreateTaskInput) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }),
  createChildTask: (parentId: number, input: CreateChildTaskInput) =>
    request<Task>(`/tasks/${parentId}/children`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createTaskSuccessor: (predecessorId: number, input: CreateChildTaskInput) =>
    request<Task>(`/tasks/${predecessorId}/successors`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createTaskSequence: (projectId: number, input: CreateTaskSequenceInput) =>
    request<Task[]>(`/projects/${projectId}/task-sequence`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTask: (id: number, patch: UpdateTaskInput) =>
    request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  promoteTaskToProject: (id: number, input: PromoteTaskToProjectInput) =>
    request<ProjectWithActions>(`/tasks/${id}/promote-to-project`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setExternalWait: (id: number, input: ExternalWaitInput) =>
    request<Task>(`/tasks/${id}/external-wait`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  resolveExternalWait: (id: number, expectedRevision?: number) =>
    request<Task>(`/tasks/${id}/external-wait`, {
      method: "DELETE",
      body: JSON.stringify(
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
    }),
  followUpExternalWait: (id: number, input: ExternalWaitFollowUpInput) =>
    request<Task>(`/tasks/${id}/external-wait/follow-up`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  transitionTaskStatus: (
    id: number,
    status: TaskStatus,
    completedOn?: string,
    expectedRevision?: number,
  ) =>
    request<Task>(`/tasks/${id}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        ...(completedOn ? { completedOn } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    }),
  clarifyTask: (id: number, expectedRevision?: number) =>
    request<Task>(`/tasks/${id}/clarify`, {
      method: "POST",
      body: JSON.stringify(
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
    }),
  appendTaskNotes: (id: number, content: string) =>
    request<Task>(`/tasks/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, { method: "DELETE" }),

  completeTask: (
    id: number,
    descendantsPolicy: TaskDescendantsPolicy = "leave_open",
    completedOn?: string,
    expectedRevision?: number,
  ) =>
    request<Task>(`/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({
        ...(descendantsPolicy ? { descendantsPolicy } : {}),
        ...(completedOn ? { completedOn } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    }),
  cancelTask: (
    id: number,
    descendantsPolicy: TaskDescendantsPolicy = "leave_open",
    expectedRevision?: number,
  ) =>
    request<Task>(`/tasks/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({
        descendantsPolicy,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    }),
  reopenTask: (id: number, expectedRevision?: number) =>
    request<Task>(`/tasks/${id}/reopen`, {
      method: "POST",
      body: JSON.stringify(
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
    }),

  moveTask: (id: number, input: MoveTaskInput) =>
    request<Task>(`/tasks/${id}/move`, { method: "POST", body: JSON.stringify(input) }),

  addDependency: (taskId: number, dependsOnTaskId: number) =>
    request<Task>(`/tasks/${taskId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnTaskId }),
    }),
  removeDependency: (taskId: number, dependsOnTaskId: number) =>
    request<Task>(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`, {
      method: "DELETE",
    }),

  addTag: (taskId: number, tagId: number) =>
    request<Task>(`/tasks/${taskId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    }),
  removeTag: (taskId: number, tagId: number) =>
    request<Task>(`/tasks/${taskId}/tags/${tagId}`, { method: "DELETE" }),
  addExcludedTag: (taskId: number, tagId: number) =>
    request<Task>(`/tasks/${taskId}/excluded-tags`, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    }),
  removeExcludedTag: (taskId: number, tagId: number) =>
    request<Task>(`/tasks/${taskId}/excluded-tags/${tagId}`, { method: "DELETE" }),
};

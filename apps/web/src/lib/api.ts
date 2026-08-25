import type {
  Agenda,
  InheritanceMode,
  Member,
  Project,
  ProjectStatus,
  SearchFilters,
  StuckProject,
  Tag,
  Task,
  TaskStatus,
  WaitingGroup,
} from "@machbar/shared";

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

export class ApiError extends Error {
  status: number;
  code?: string | undefined;
  details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
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
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_ROOT}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let details: unknown;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (body?.error?.message) message = body.error.message;
      code = body?.error?.code;
      details = body?.error?.details;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new ApiError(res.status, message || "Anfrage fehlgeschlagen", code, details);
  }
  if (res.status === 204) return undefined as T;
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

/** Matches `apps/api/src/schemas.ts::completeTaskSchema`. */
export type CompleteDescendantsPolicy = "leave_open" | "complete_children";
/** Matches `apps/api/src/schemas.ts::cancelTaskSchema`. */
export type CancelDescendantsPolicy = "leave_open" | "cancel_children";

export interface MoveTaskInput {
  parentTaskId?: number | null;
  projectId?: number | null;
  position?: number;
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  projectId?: number | null;
  parentTaskId?: number | null;
  status?: TaskStatus;
  ownerMemberId?: number | null;
  ownerInheritanceMode?: InheritanceMode;
  createdByMemberId?: number | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  waitingFor?: string | null;
  context?: string | null;
  contextInheritanceMode?: InheritanceMode;
  priority?: number | null;
  recurrenceRule?: string | null;
  reminderAt?: string | null;
  tagIds?: number[];
}

/** Body for `POST /api/tasks/:id/children` (no `projectId`/`parentTaskId`, both implied). */
export type CreateChildTaskInput = Omit<CreateTaskInput, "projectId" | "parentTaskId">;

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "parentTaskId" | "projectId">> & {
  excludedTagIds?: number[];
};

export interface CreateProjectInput {
  title: string;
  description?: string;
  status?: ProjectStatus;
  ownerMemberId?: number | null;
  context?: string | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  tagIds?: number[];
}

export type UpdateProjectInput = Partial<CreateProjectInput> & { position?: number };

export interface CreateMemberInput {
  name: string;
}

export type UpdateMemberInput = Partial<CreateMemberInput>;

/**
 * `@machbar/shared`'s `Agenda` type now declares a `revisit` bucket for
 * blocked tasks whose `scheduledDate` has arrived (see
 * `apps/api/src/domain/agenda.ts` / the shared `Agenda` interface), but the
 * compiled `@machbar/shared` artifact this app builds against may still lag
 * behind that source change depending on build order. Extending the type
 * locally with an optional `revisit` keeps the frontend typechecking and
 * rendering correctly either way — before the field exists, while it's
 * being wired up, and once it's guaranteed present — with no further
 * frontend change needed once every build is in sync.
 */
export type AgendaResponse = Agenda & {
  revisit?: Task[];
};

export const api = {
  getMembers: () => request<Member[]>("/members"),
  createMember: (input: CreateMemberInput) =>
    request<Member>("/members", { method: "POST", body: JSON.stringify(input) }),
  updateMember: (id: number, patch: UpdateMemberInput) =>
    request<Member>(`/members/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMember: (id: number) => request<void>(`/members/${id}`, { method: "DELETE" }),

  getTags: () => request<Tag[]>("/tags"),
  createTag: (name: string) =>
    request<Tag>("/tags", { method: "POST", body: JSON.stringify({ name }) }),

  getProjects: () => request<Project[]>("/projects"),
  getStuckProjects: () => request<StuckProject[]>("/projects/stuck"),
  getProject: (id: number) => request<Project & { tasks: Task[] }>(`/projects/${id}`),
  createProject: (input: CreateProjectInput) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (id: number, patch: UpdateProjectInput) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  archiveProject: (id: number) =>
    request<Project>(`/projects/${id}/archive`, { method: "POST" }),
  unarchiveProject: (id: number) =>
    request<Project>(`/projects/${id}/unarchive`, { method: "POST" }),

  /**
   * `memberId` scopes the agenda to a single member (the currently
   * selected identity from `useIdentity`) so the frontend never fetches
   * -- and thus never accidentally renders -- another member's tasks.
   * Shared/unassigned tasks still come back regardless, since the
   * backend includes those for every member. Passing `null`/`undefined`
   * (e.g. while no identity is selected yet) omits the param entirely.
   */
  getAgenda: (memberId?: number | null) =>
    request<AgendaResponse>(`/agenda/today${query({ memberId })}`),
  getInbox: () => request<Task[]>("/inbox"),
  getWaiting: () => request<WaitingGroup[]>("/waiting"),
  searchTasks: (filters: SearchFilters) =>
    request<Task[]>(
      `/search${query({
        text: filters.text,
        ownerId: filters.ownerId,
        projectId: filters.projectId,
        effectiveContext: filters.effectiveContext,
        explicitContext: filters.explicitContext,
        tagIds: filters.tagIds,
        status: filters.status,
        dueFrom: filters.dueFrom,
        dueTo: filters.dueTo,
        scheduledFrom: filters.scheduledFrom,
        scheduledTo: filters.scheduledTo,
        waitingFor: filters.waitingFor,
      })}`,
    ),

  getTask: (id: number) => request<Task>(`/tasks/${id}`),
  createTask: (input: CreateTaskInput) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }),
  createChildTask: (parentId: number, input: CreateChildTaskInput) =>
    request<Task>(`/tasks/${parentId}/children`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTask: (id: number, patch: UpdateTaskInput) =>
    request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, { method: "DELETE" }),

  completeTask: (id: number, descendantsPolicy?: CompleteDescendantsPolicy) =>
    request<Task>(`/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify(descendantsPolicy ? { descendantsPolicy } : {}),
    }),
  cancelTask: (id: number, descendantsPolicy?: CancelDescendantsPolicy) =>
    request<Task>(`/tasks/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(descendantsPolicy ? { descendantsPolicy } : {}),
    }),
  reopenTask: (id: number) => request<Task>(`/tasks/${id}/reopen`, { method: "POST" }),

  moveTask: (id: number, input: MoveTaskInput) =>
    request<Task>(`/tasks/${id}/move`, { method: "POST", body: JSON.stringify(input) }),
  reorderTask: (id: number, position: number) =>
    request<Task>(`/tasks/${id}/reorder`, {
      method: "POST",
      body: JSON.stringify({ position }),
    }),
  indentTask: (id: number) => request<Task>(`/tasks/${id}/indent`, { method: "POST" }),
  outdentTask: (id: number) => request<Task>(`/tasks/${id}/outdent`, { method: "POST" }),
  changeParent: (id: number, parentTaskId: number | null, projectId?: number | null) =>
    request<Task>(`/tasks/${id}/parent`, {
      method: "POST",
      body: JSON.stringify(
        projectId !== undefined ? { parentTaskId, projectId } : { parentTaskId },
      ),
    }),
  moveSubtree: (id: number, projectId: number | null) =>
    request<Task>(`/tasks/${id}/move-subtree`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

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

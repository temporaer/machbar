/**
 * WorkItem projection over the unified `work_items` table. It presents tasks
 * and stories through one shared vocabulary — `role`, `parentId`, `lifecycle`,
 * and ordered recursive `children` — while the public `/api/tasks` and
 * `/api/projects` response shapes remain role-specific adapters.
 */
import type { ProjectStatus, TaskSize, TaskStatus } from "@machbar/shared";
import type { ProjectRecord, TaskRecord } from "./graph.js";

export type WorkItemRole = "task" | "story";

/** Shared lifecycle vocabulary stored by `work_items.status`. */
export type WorkItemLifecycle =
  | "captured"
  | "backlog"
  | "active"
  | "done"
  | "cancelled";

/** Role-specific UI label for a given lifecycle stage, per the mapping the
 * user specified (task+active -> actionable, story+backlog -> backlog,
 * etc.). Exact German/English copy lives in i18n; this returns the stable
 * vocabulary key, not display copy. */
export type WorkItemLabel =
  | "captured"
  | "actionable"
  | "someday"
  | "done"
  | "cancelled"
  | "backlog"
  | "active"
  | "completed"
  | "archived";

export function taskLifecycle(status: TaskStatus): WorkItemLifecycle {
  switch (status) {
    case "captured":
      return "captured";
    case "actionable":
      return "active";
    case "someday":
      return "backlog";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

export function projectLifecycle(status: ProjectStatus): WorkItemLifecycle {
  switch (status) {
    case "backlog":
      return "backlog";
    case "active":
      return "active";
    case "completed":
      return "done";
    case "archived":
      return "backlog";
  }
}

/** Inverse of {@link taskLifecycle}: used when converting a story back to a
 * task, to pick the task status corresponding to the story's current
 * lifecycle stage (Phase 2, `convertStoryToTask`). */
export function lifecycleToTaskStatus(lifecycle: WorkItemLifecycle): TaskStatus {
  switch (lifecycle) {
    case "captured":
      return "captured";
    case "active":
      return "actionable";
    case "backlog":
      return "someday";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

export function workItemLabel(
  role: WorkItemRole,
  lifecycle: WorkItemLifecycle,
  { archived = false }: { archived?: boolean } = {},
): WorkItemLabel {
  if (role === "task") {
    switch (lifecycle) {
      case "captured":
        return "captured";
      case "active":
        return "actionable";
      case "backlog":
        return "someday";
      case "done":
        return "done";
      case "cancelled":
        return "cancelled";
    }
  }
  // role === "story"
  if (archived) return "archived";
  switch (lifecycle) {
    case "captured":
      return "captured";
    case "active":
      return "active";
    case "backlog":
      return "backlog";
    case "done":
      return "completed";
    case "cancelled":
      return "archived";
  }
}

export interface WorkItemView {
  id: number;
  revision: number;
  role: WorkItemRole;
  parentId: number | null;
  title: string;
  notes: string;
  lifecycle: WorkItemLifecycle;
  label: WorkItemLabel;
  ownerMemberId: number | null;
  dueDate: string | null;
  scheduledDate: string | null;
  size: TaskSize | null;
  position: number;
  children: WorkItemView[];
}

export function taskToWorkItem(task: TaskRecord): WorkItemView {
  return {
    id: task.id,
    revision: task.revision,
    role: "task",
    parentId: task.parentTaskId,
    title: task.title,
    notes: task.notes,
    lifecycle: taskLifecycle(task.status),
    label: workItemLabel("task", taskLifecycle(task.status)),
    ownerMemberId: task.ownerMemberId,
    dueDate: task.dueDate,
    scheduledDate: task.scheduledDate,
    size: task.size,
    position: task.position,
    children: task.children.map(taskToWorkItem),
  };
}

export function projectToWorkItem(
  project: ProjectRecord,
  rootTasks: TaskRecord[],
  rootTasksForProject: (projectId: number) => TaskRecord[] = () => [],
): WorkItemView {
  const lifecycle = projectLifecycle(project.status);
  return {
    id: project.id,
    revision: project.revision,
    role: "story",
    parentId: project.parentId,
    title: project.title,
    notes: project.notes,
    lifecycle,
    label: workItemLabel("story", lifecycle, {
      archived: project.status === "archived",
    }),
    ownerMemberId: project.ownerMemberId,
    dueDate: project.dueDate,
    scheduledDate: project.scheduledDate,
    size: null,
    position: project.position,
    children: [
      ...project.childStories.map((story) =>
        projectToWorkItem(story, rootTasksForProject(story.id), rootTasksForProject),
      ),
      ...rootTasks.map(taskToWorkItem),
    ].sort((a, b) => a.position - b.position),
  };
}

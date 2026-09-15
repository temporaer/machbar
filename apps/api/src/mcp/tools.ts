import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkItemScope } from "@machbar/shared";
import type { Db } from "../db/client.js";
import { buildAgenda } from "../domain/agenda.js";
import { Graph, type TaskDetailRecord } from "../domain/graph.js";
import { buildReviewItems } from "../domain/reviewItems.js";
import { searchTasks } from "../domain/search.js";
import { moveTask } from "../domain/structuralMoves.js";
import { resolveExternalWait } from "../domain/taskCapabilities.js";
import { createTask, updateTask } from "../domain/taskCrud.js";
import { cancelTask, completeTask } from "../domain/taskWorkflow.js";
import { buildWaitingEntries } from "../domain/waiting.js";
import { isIsoCalendarDate } from "../domain/calendarDate.js";
import { getMemberOrThrow, listMembers } from "../domain/members.js";
import {
  activateProject,
  archiveProject,
  completeProject,
  reopenProject,
  returnProjectToBacklog,
} from "../domain/storyWorkflow.js";
import { AppError } from "../errors.js";
import {
  contextAvailabilityForHousehold,
  contextAvailabilityForMember,
} from "../integrations/homeAssistant.js";

export interface MachbarMcpContext {
  db: Db;
  memberId: number;
  scope: WorkItemScope;
}

const calendarDate = z
  .string()
  .describe("Calendar date in YYYY-MM-DD format only. Do not include a time or timezone.")
  .refine(
    isIsoCalendarDate,
    "Calendar date must use YYYY-MM-DD format only. Do not include a time or timezone.",
  )
  .optional();
const taskId = z.number().int().positive();
const projectId = z.number().int().positive();
const expectedRevision = z.number().int().positive();
const mcpAbsoluteAtSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .describe("Absolute reminder time as a full RFC3339/ISO timestamp.");
const mcpAbsoluteReminderSchema = z.object({ at: mcpAbsoluteAtSchema });
const mcpAbsoluteRemindersSchema = z.array(mcpAbsoluteReminderSchema);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function graphFor(db: Db, memberId: number, date?: string): Graph {
  return Graph.load(db, date, memberId);
}

function taskOrThrow(
  db: Db,
  id: number,
  memberId: number,
): TaskDetailRecord {
  const graph = graphFor(db, memberId);
  const task = graph.tasksById.get(id);
  if (!task) {
    throw AppError.notFound("task_not_found", "The requested task was not found.", {
      taskId: id,
    });
  }
  return { ...task, ancestors: graph.taskAncestorsFor(id) };
}

function projectOrThrow(db: Db, id: number, memberId: number) {
  const graph = graphFor(db, memberId);
  const project = graph.projectWithComputed(id);
  if (!project) {
    throw AppError.notFound(
      "project_not_found",
      "The requested project was not found.",
      { projectId: id },
    );
  }
  return { ...project, tasks: graph.rootsByProject.get(id) ?? [] };
}

export function createMachbarMcpServer({
  db,
  memberId,
  scope: agentScope,
}: MachbarMcpContext): McpServer {
  const server = new McpServer({
    name: "machbar",
    version: "0.1.0",
  });
  const mutationContext = { actorMemberId: memberId };
  const agendaScope = agentScope === "work" ? "work" : "all";

  const scopedTaskOrThrow = (id: number) => {
    const task = taskOrThrow(db, id, memberId);
    if (task.scope !== agentScope) {
      throw AppError.notFound(
        "task_not_found",
        "The requested task was not found.",
        { taskId: id },
      );
    }
    return task;
  };

  const scopedProjectOrThrow = (id: number) => {
    const project = projectOrThrow(db, id, memberId);
    if (project.scope !== agentScope) {
      throw AppError.notFound(
        "project_not_found",
        "The requested project was not found.",
        { projectId: id },
      );
    }
    return project;
  };

  server.registerTool(
    "machbar_today",
    {
      description:
        "List Machbar Today. In household scope, omitted memberId means the whole household; provide a stable memberId to focus on that member and shared tasks. The authenticated member is the OAuth identity, not necessarily the speaker. date is a calendar date in YYYY-MM-DD format only, never a time or timezone.",
      inputSchema: {
        date: calendarDate,
        memberId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ date, memberId: requestedMemberId }) => {
      const selectedMemberId =
        agentScope === "work"
          ? memberId
          : requestedMemberId === undefined
            ? undefined
            : (getMemberOrThrow(db, requestedMemberId), requestedMemberId);
      const graph = graphFor(db, memberId, date);
      return result(
        buildAgenda(graph, {
          memberId: selectedMemberId,
          today: date,
          scope: agendaScope,
          contextAvailability: (task, target) =>
            target === "household"
              ? contextAvailabilityForHousehold(db, task.effectiveContexts)
              : contextAvailabilityForMember(db, task.effectiveContexts, target),
        }),
      );
    },
  );

  server.registerTool(
    "machbar_list_members",
    {
      description:
        "List household members so the model can resolve names to stable member IDs. isAuthenticatedMember identifies the OAuth identity only; it does not identify the person speaking through Home Assistant.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        listMembers(db).map((member) => ({
          id: member.id,
          name: member.name,
          color: member.color,
          pictureUrl: member.pictureUrl,
          isAuthenticatedMember: member.id === memberId,
        })),
      ),
  );

  server.registerTool(
    "machbar_review",
    {
      description: "List Machbar items currently requiring review.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const graph = graphFor(db, memberId);
      const items = buildReviewItems(graph).filter((item) => {
        const entity =
          item.entityType === "task"
            ? graph.tasksById.get(item.entityId)
            : graph.projectsById.get(item.entityId);
        return entity?.scope === agentScope;
      });
      return result(items);
    },
  );

  server.registerTool(
    "machbar_waiting",
    {
      description: "List tasks blocked by dependencies, waits, or context.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        buildWaitingEntries(graphFor(db, memberId), {
          memberId: agentScope === "work" ? memberId : undefined,
          scope: agendaScope,
          contextAvailability: (task, target) =>
            target === "household"
              ? contextAvailabilityForHousehold(db, task.effectiveContexts)
              : contextAvailabilityForMember(db, task.effectiveContexts, target),
        }),
      ),
  );

  server.registerTool(
    "machbar_search",
    {
      description:
        "Search Machbar tasks using structured filters. ownerId filters effective ownership, including inherited owners; ownerId null finds genuinely shared/unassigned tasks. dueFrom, dueTo, scheduledFrom, and scheduledTo are calendar dates in YYYY-MM-DD format only, never times or timezones.",
      inputSchema: {
        text: z.string().optional(),
        projectId: z.number().int().positive().optional(),
        ownerId: z.number().int().positive().nullable().optional(),
        tagIds: z.array(z.number().int().positive()).optional(),
        status: z
          .enum(["captured", "actionable", "someday", "done", "cancelled"])
          .optional(),
        dueFrom: calendarDate,
        dueTo: calendarDate,
        scheduledFrom: calendarDate,
        scheduledTo: calendarDate,
        blocked: z.boolean().optional(),
        externalWait: z.boolean().optional(),
        includeTerminal: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (filters) => {
      if (
        agentScope === "household" &&
        filters.ownerId !== undefined &&
        filters.ownerId !== null
      ) {
        getMemberOrThrow(db, filters.ownerId);
      }
      return result(
        searchTasks(graphFor(db, memberId), filters).filter(
          (task) => task.scope === agentScope,
        ),
      );
    },
  );

  server.registerTool(
    "machbar_get_task",
    {
      description: "Get one Machbar task, including derived state and ancestors.",
      inputSchema: { taskId },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => result(scopedTaskOrThrow(taskId)),
  );

  server.registerTool(
    "machbar_get_project",
    {
      description: "Get one Machbar project and its root tasks.",
      inputSchema: { projectId },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => result(scopedProjectOrThrow(projectId)),
  );

  server.registerTool(
    "machbar_list_projects",
    {
      description: "List Machbar projects with computed workflow state.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        graphFor(db, memberId)
          .listProjectsWithComputed()
          .filter((project) => project.scope === agentScope),
      ),
  );

  server.registerTool(
    "machbar_create_task",
    {
      description:
        "Create a Machbar task. In household scope, the authenticated member is not necessarily the speaker: an omitted ownerMemberId creates an explicitly shared/unassigned task, and ambiguous ownership must remain shared. Resolve names with machbar_list_members and pass a stable member ID when ownership is explicit. In work scope, ownership is always forced to the authenticated member. dueDate and scheduledDate are calendar dates in YYYY-MM-DD format only, never times or timezones. MCP task creation accepts absolute reminders with at as a full RFC3339/ISO timestamp; existing deadline-relative reminders remain an internal/UI feature.",
      inputSchema: {
        title: z.string().min(1),
        notes: z.string().optional(),
        projectId: z.number().int().positive().nullable().optional(),
        parentTaskId: z.number().int().positive().nullable().optional(),
        status: z
          .enum(["captured", "actionable", "someday"])
          .optional(),
        ownerMemberId: z.number().int().positive().nullable().optional(),
        dueDate: calendarDate.nullable(),
        scheduledDate: calendarDate.nullable(),
        reminders: mcpAbsoluteRemindersSchema.optional(),
        priority: z.number().int().nullable().optional(),
        size: z.enum(["S", "M", "L", "XL"]).nullable().optional(),
        tagIds: z.array(z.number().int().positive()).optional(),
        contextIds: z.array(z.number().int().positive()).optional(),
      },
    },
    async (input) => {
      const { reminders: mcpReminders, ...taskInput } = input;
      if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
        scopedTaskOrThrow(input.parentTaskId);
      }
      if (input.projectId !== undefined && input.projectId !== null) {
        scopedProjectOrThrow(input.projectId);
      }
      if (
        agentScope === "household" &&
        input.ownerMemberId !== undefined &&
        input.ownerMemberId !== null
      ) {
        getMemberOrThrow(db, input.ownerMemberId);
      }
      const ownerMemberId =
        agentScope === "work" ? memberId : (input.ownerMemberId ?? null);
      const created = createTask(
        db,
        {
          ...taskInput,
          ...(mcpReminders !== undefined
            ? {
                reminders: mcpReminders.map((reminder) => ({
                  kind: "absolute" as const,
                  at: reminder.at,
                })),
              }
            : {}),
          ownerMemberId,
          ownerInheritanceMode: ownerMemberId === null ? "none" : "explicit",
          ...(input.contextIds !== undefined
            ? { contextInheritanceMode: "explicit" as const }
            : {}),
          scope: agentScope,
          createdByMemberId: memberId,
        },
        mutationContext,
      );
      return result(scopedTaskOrThrow(created.id));
    },
  );

  server.registerTool(
    "machbar_complete_task",
    {
      description:
        "Complete a Machbar task using its current revision. completedOn, when supplied for recurring work, is a calendar date in YYYY-MM-DD format only, never a time or timezone.",
      inputSchema: {
        taskId,
        expectedRevision,
        descendantsPolicy: z
          .enum(["leave_open", "complete_children", "cancel_children"])
          .optional(),
        completedOn: calendarDate,
      },
      annotations: { destructiveHint: true },
    },
    async ({ taskId, descendantsPolicy, completedOn, expectedRevision }) => {
      scopedTaskOrThrow(taskId);
      completeTask(
        db,
        taskId,
        descendantsPolicy,
        mutationContext,
        completedOn,
        expectedRevision,
      );
      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_cancel_task",
    {
      description:
        "Cancel a Machbar task using its current revision, for work that will not be completed.",
      inputSchema: {
        taskId,
        expectedRevision,
        descendantsPolicy: z
          .enum(["leave_open", "complete_children", "cancel_children"])
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ taskId, descendantsPolicy, expectedRevision }) => {
      scopedTaskOrThrow(taskId);
      cancelTask(
        db,
        taskId,
        descendantsPolicy,
        mutationContext,
        expectedRevision,
      );
      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_update_task",
    {
      description:
        "Update atomic task metadata. Use the latest revision to avoid stale writes. In household scope, the authenticated member is not necessarily the speaker; omit ownerMemberId to leave ownership unchanged, pass null to make the task explicitly shared/unassigned, or pass a stable member ID resolved with machbar_list_members. dueDate and scheduledDate are calendar dates in YYYY-MM-DD format only, never times or timezones.",
      inputSchema: {
        taskId,
        expectedRevision,
        ownerMemberId: z.number().int().positive().nullable().optional(),
        dueDate: calendarDate.nullable(),
        scheduledDate: calendarDate.nullable(),
        priority: z.number().int().nullable().optional(),
        size: z.enum(["S", "M", "L", "XL"]).nullable().optional(),
        tagIds: z.array(z.number().int().positive()).optional(),
        contextIds: z.array(z.number().int().positive()).optional(),
        additionalNextAction: z.boolean().optional(),
      },
    },
    async ({ taskId, ...input }) => {
      scopedTaskOrThrow(taskId);
      if (
        agentScope === "household" &&
        input.ownerMemberId !== undefined &&
        input.ownerMemberId !== null
      ) {
        getMemberOrThrow(db, input.ownerMemberId);
      }
      const ownerMemberId =
        agentScope === "work" && input.ownerMemberId !== undefined
          ? memberId
          : input.ownerMemberId;
      updateTask(
        db,
        taskId,
        {
          ...input,
          ...(ownerMemberId !== undefined
            ? {
                ownerMemberId,
                ownerInheritanceMode:
                  ownerMemberId === null ? "none" : "explicit",
              }
            : {}),
          ...(input.contextIds !== undefined
            ? { contextInheritanceMode: "explicit" as const }
            : {}),
        },
        mutationContext,
      );

      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_manage_reminder",
    {
      description:
        "Add, update, or remove one absolute task reminder through the canonical task mutation. Use the latest expectedRevision. at is a full RFC3339/ISO timestamp. Reminder IDs are stable; provide reminderId for update/remove. MCP does not create, update, or remove deadline-relative reminders. Captured inbox tasks cannot carry reminders.",
      inputSchema: {
        taskId,
        expectedRevision,
        operation: z.enum(["add", "update", "remove"]),
        reminderId: z.number().int().positive().optional(),
        at: mcpAbsoluteAtSchema.optional(),
      },
    },
    async ({ taskId, expectedRevision, operation, reminderId, at }) => {
      const task = scopedTaskOrThrow(taskId);
      if (operation === "add") {
        if (!at) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "Adding a reminder requires an at timestamp.",
          );
        }
        updateTask(
          db,
          taskId,
          {
            reminders: [
              ...task.reminders,
              { kind: "absolute", at },
            ],
            expectedRevision,
          },
          mutationContext,
        );
      } else if (operation === "update") {
        if (reminderId === undefined || !at) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "Updating a reminder requires reminderId and an at timestamp.",
          );
        }
        const index = task.reminders.findIndex(({ id }) => id === reminderId);
        if (index < 0) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "A reminder id does not belong to this task.",
            { taskId, reminderId },
          );
        }
        if (task.reminders[index]!.kind !== "absolute") {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "MCP can only update absolute reminders.",
            { taskId, reminderId },
          );
        }
        const reminders = [...task.reminders];
        reminders[index] = {
          id: reminderId,
          kind: "absolute",
          at,
        };
        updateTask(db, taskId, { reminders, expectedRevision }, mutationContext);
      } else {
        if (reminderId === undefined) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "Removing a reminder requires reminderId.",
          );
        }
        const reminders = task.reminders.filter(({ id }) => id !== reminderId);
        if (reminders.length === task.reminders.length) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "A reminder id does not belong to this task.",
            { taskId, reminderId },
          );
        }
        if (
          task.reminders.find(({ id }) => id === reminderId)!.kind !==
          "absolute"
        ) {
          throw AppError.badRequest(
            "task_reminder_invalid",
            "MCP can only remove absolute reminders.",
            { taskId, reminderId },
          );
        }
        updateTask(db, taskId, { reminders, expectedRevision }, mutationContext);
      }
      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_move_task",
    {
      description: "Move or reorder a task using the canonical hierarchy command.",
      inputSchema: {
        taskId,
        expectedRevision: z.number().int().positive(),
        parentTaskId: z.number().int().positive().nullable().optional(),
        projectId: z.number().int().positive().nullable().optional(),
        position: z.number().int().min(0).optional(),
      },
    },
    async ({ taskId, ...input }) => {
      scopedTaskOrThrow(taskId);
      if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
        scopedTaskOrThrow(input.parentTaskId);
      }
      if (input.projectId !== undefined && input.projectId !== null) {
        scopedProjectOrThrow(input.projectId);
      }
      moveTask(db, taskId, input, mutationContext);
      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_resolve_waiting",
    {
      description: "Resolve a task's external wait.",
      inputSchema: { taskId, expectedRevision },
    },
    async ({ taskId, expectedRevision }) => {
      scopedTaskOrThrow(taskId);
      resolveExternalWait(db, taskId, expectedRevision, mutationContext);
      return result(scopedTaskOrThrow(taskId));
    },
  );

  server.registerTool(
    "machbar_project_lifecycle_command",
    {
      description:
        "Run one legal project lifecycle action from the project's availableActions.",
      inputSchema: {
        projectId,
        action: z.enum([
          "activate",
          "return_to_backlog",
          "complete",
          "reopen",
          "archive",
        ]),
        expectedRevision,
        ownerMemberId: z.number().int().positive().nullable().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ projectId, action, expectedRevision, ownerMemberId }) => {
      scopedProjectOrThrow(projectId);
      if (
        agentScope === "household" &&
        ownerMemberId !== undefined &&
        ownerMemberId !== null
      ) {
        getMemberOrThrow(db, ownerMemberId);
      }
      const lifecycleOwnerMemberId =
        agentScope === "work" && ownerMemberId !== undefined
          ? memberId
          : ownerMemberId;
      switch (action) {
        case "activate":
          activateProject(
            db,
            projectId,
            { expectedRevision, ownerMemberId: lifecycleOwnerMemberId },
            mutationContext,
          );
          break;
        case "return_to_backlog":
          returnProjectToBacklog(
            db,
            projectId,
            mutationContext,
            expectedRevision,
          );
          break;
        case "complete":
          completeProject(db, projectId, mutationContext, expectedRevision);
          break;
        case "reopen":
          reopenProject(
            db,
            projectId,
            mutationContext,
            expectedRevision,
            lifecycleOwnerMemberId,
          );
          break;
        case "archive":
          archiveProject(db, projectId, mutationContext, expectedRevision);
          break;
      }
      return result(scopedProjectOrThrow(projectId));
    },
  );

  return server;
}

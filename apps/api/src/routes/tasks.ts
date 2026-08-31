import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { getTaskRecurrenceHistory } from "../repo/recurrenceRepo.js";
import {
  acknowledgeTaskReview,
  addDependency,
  addExcludedTag,
  addTaskTag,
  appendTaskNotes,
  cancelTask,
  clarifyTask,
  completeTask,
  createChildTask,
  createTaskSuccessor,
  createTask,
  deleteTask,
  followUpExternalWait,
  moveTask,
  promoteTaskToProject,
  removeDependency,
  removeExcludedTag,
  removeTaskTag,
  resolveExternalWait,
  reopenTask,
  upsertExternalWait,
  updateTask,
} from "../domain/mutations.js";
import {
  acknowledgeReviewSchema,
  appendNotesSchema,
  cancelTaskSchema,
  completeTaskSchema,
  createChildTaskSchema,
  createTaskSchema,
  dependencySchema,
  externalWaitFollowUpSchema,
  moveTaskSchema,
  promoteTaskToProjectSchema,
  tagRefSchema,
  taskLifecycleSchema,
  transitionTaskStatusSchema,
  updateTaskSchema,
  upsertExternalWaitSchema,
  resolveExternalWaitSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest(
      "identifier_invalid",
      "The task ID must be a number.",
      { resource: "task", value: raw },
    );
  }
  return id;
}

function taskOrThrow(db: Db, id: number) {
  const graph = Graph.load(db);
  const task = graph.tasksById.get(id);
  if (!task) {
    throw AppError.notFound(
      "task_not_found",
      "The requested task was not found.",
      { taskId: id },
    );
  }
  return task;
}

export function registerTaskRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const id = parseId(request.params.id);
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/review",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(acknowledgeReviewSchema, request.body ?? {});
      acknowledgeTaskReview(db, id, body.expectedRevision, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/recurrence-history",
    async (request) => {
      const id = parseId(request.params.id);
      taskOrThrow(db, id);
      return getTaskRecurrenceHistory(db, id);
    },
  );

  app.post("/api/tasks", async (request, reply) => {
    const body = parseOrThrow(createTaskSchema, request.body);
    const task = createTask(
      db,
      {
        ...body,
        ...(request.authMember
          ? { createdByMemberId: request.authMember.id }
          : {}),
      },
      { actorMemberId: request.activityActor?.id ?? null },
    );
    reply.status(201);
    return taskOrThrow(db, task.id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/children",
    async (request, reply) => {
      const parentId = parseId(request.params.id);
      const body = parseOrThrow(createChildTaskSchema, request.body);
      const task = createChildTask(
        db,
        parentId,
        {
          ...body,
          ...(request.authMember
            ? { createdByMemberId: request.authMember.id }
            : {}),
        },
        { actorMemberId: request.activityActor?.id ?? null },
      );
      reply.status(201);
      return taskOrThrow(db, task.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/successors",
    async (request, reply) => {
      const predecessorId = parseId(request.params.id);
      const body = parseOrThrow(createChildTaskSchema, request.body);
      const task = createTaskSuccessor(
        db,
        predecessorId,
        {
          ...body,
          ...(request.authMember
            ? { createdByMemberId: request.authMember.id }
            : {}),
        },
        { actorMemberId: request.activityActor?.id ?? null },
      );
      reply.status(201);
      return taskOrThrow(db, task.id);
    },
  );

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(updateTaskSchema, request.body);
    updateTask(db, id, body, {
      actorMemberId: request.activityActor?.id ?? null,
    });
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/notes",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(appendNotesSchema, request.body);
      appendTaskNotes(db, id, body.content, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteTask(db, id, { actorMemberId: request.activityActor?.id ?? null });
      reply.status(204);
      return null;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/status",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(transitionTaskStatusSchema, request.body);
      updateTask(
        db,
        id,
        {
          status: body.status,
          completedOn: body.completedOn,
          expectedRevision: body.expectedRevision,
        },
        { actorMemberId: request.activityActor?.id ?? null },
      );
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/promote-to-project",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(promoteTaskToProjectSchema, request.body);
      const project = promoteTaskToProject(db, id, body, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      const graph = Graph.load(db);
      reply.status(201);
      return graph.projectWithComputed(project.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/complete",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(completeTaskSchema, request.body ?? {});
      completeTask(
        db,
        id,
        body.descendantsPolicy,
        { actorMemberId: request.activityActor?.id ?? null },
        body.completedOn,
        body.expectedRevision,
      );
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(cancelTaskSchema, request.body ?? {});
      cancelTask(
        db,
        id,
        body.descendantsPolicy,
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
      );
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/reopen",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(taskLifecycleSchema, request.body ?? {});
      reopenTask(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
      );
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/clarify",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(taskLifecycleSchema, request.body ?? {});
      clarifyTask(db, id, body.expectedRevision, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/move", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(moveTaskSchema, request.body);
    moveTask(db, id, body, {
      actorMemberId: request.activityActor?.id ?? null,
    });
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/dependencies",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(dependencySchema, request.body);
      addDependency(db, id, body.dependsOnTaskId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/tasks/:id/external-wait",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(upsertExternalWaitSchema, request.body ?? {});
      upsertExternalWait(db, id, body, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id/external-wait",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(resolveExternalWaitSchema, request.body ?? {});
      resolveExternalWait(db, id, body.expectedRevision, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/external-wait/follow-up",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(externalWaitFollowUpSchema, request.body);
      followUpExternalWait(db, id, body, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; dependsOnTaskId: string } }>(
    "/api/tasks/:id/dependencies/:dependsOnTaskId",
    async (request) => {
      const id = parseId(request.params.id);
      const dependsOnTaskId = parseId(request.params.dependsOnTaskId);
      removeDependency(db, id, dependsOnTaskId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/tags",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(tagRefSchema, request.body);
      addTaskTag(db, id, body.tagId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/tasks/:id/tags/:tagId",
    async (request) => {
      const id = parseId(request.params.id);
      const tagId = parseId(request.params.tagId);
      removeTaskTag(db, id, tagId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/excluded-tags",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(tagRefSchema, request.body);
      addExcludedTag(db, id, body.tagId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/tasks/:id/excluded-tags/:tagId",
    async (request) => {
      const id = parseId(request.params.id);
      const tagId = parseId(request.params.tagId);
      removeExcludedTag(db, id, tagId, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      return taskOrThrow(db, id);
    },
  );
}

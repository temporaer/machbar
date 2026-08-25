import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import {
  addDependency,
  addExcludedTag,
  addTaskTag,
  cancelTask,
  changeTaskParent,
  completeTask,
  createChildTask,
  createTaskSuccessor,
  createTask,
  deleteTask,
  indentTask,
  moveSubtreeToProject,
  moveTask,
  outdentTask,
  removeDependency,
  removeExcludedTag,
  removeTaskTag,
  reopenTask,
  reorderTask,
  updateTask,
} from "../domain/mutations.js";
import {
  cancelTaskSchema,
  changeParentSchema,
  completeTaskSchema,
  createChildTaskSchema,
  createTaskSchema,
  dependencySchema,
  moveSubtreeSchema,
  moveTaskSchema,
  reorderTaskSchema,
  tagRefSchema,
  updateTaskSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Die ID muss eine Zahl sein.");
  }
  return id;
}

function taskOrThrow(db: Db, id: number) {
  const graph = Graph.load(db);
  const task = graph.tasksById.get(id);
  if (!task) {
    throw AppError.notFound(`Aufgabe mit ID ${id} wurde nicht gefunden.`);
  }
  return task;
}

export function registerTaskRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const id = parseId(request.params.id);
    return taskOrThrow(db, id);
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = parseOrThrow(createTaskSchema, request.body);
    const task = createTask(db, {
      ...body,
      ...(request.authMember
        ? { createdByMemberId: request.authMember.id }
        : {}),
    });
    reply.status(201);
    return taskOrThrow(db, task.id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/children",
    async (request, reply) => {
      const parentId = parseId(request.params.id);
      const body = parseOrThrow(createChildTaskSchema, request.body);
      const task = createChildTask(db, parentId, {
        ...body,
        ...(request.authMember
          ? { createdByMemberId: request.authMember.id }
          : {}),
      });
      reply.status(201);
      return taskOrThrow(db, task.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/successors",
    async (request, reply) => {
      const predecessorId = parseId(request.params.id);
      const body = parseOrThrow(createChildTaskSchema, request.body);
      const task = createTaskSuccessor(db, predecessorId, {
        ...body,
        ...(request.authMember
          ? { createdByMemberId: request.authMember.id }
          : {}),
      });
      reply.status(201);
      return taskOrThrow(db, task.id);
    },
  );

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(updateTaskSchema, request.body);
    updateTask(db, id, body);
    return taskOrThrow(db, id);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteTask(db, id);
      reply.status(204);
      return null;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/complete",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(completeTaskSchema, request.body ?? {});
      completeTask(db, id, body.descendantsPolicy);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(cancelTaskSchema, request.body ?? {});
      cancelTask(db, id, body.descendantsPolicy);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/reopen",
    async (request) => {
      const id = parseId(request.params.id);
      reopenTask(db, id);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/move", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(moveTaskSchema, request.body);
    moveTask(db, id, body);
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/reorder",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(reorderTaskSchema, request.body);
      reorderTask(db, id, body.position);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/indent", async (request) => {
    const id = parseId(request.params.id);
    indentTask(db, id);
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/outdent",
    async (request) => {
      const id = parseId(request.params.id);
      outdentTask(db, id);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/parent", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(changeParentSchema, request.body);
    changeTaskParent(db, id, body.parentTaskId, body.projectId);
    return taskOrThrow(db, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/move-subtree",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(moveSubtreeSchema, request.body);
      moveSubtreeToProject(db, id, body.projectId);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/dependencies",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(dependencySchema, request.body);
      addDependency(db, id, body.dependsOnTaskId);
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; dependsOnTaskId: string } }>(
    "/api/tasks/:id/dependencies/:dependsOnTaskId",
    async (request) => {
      const id = parseId(request.params.id);
      const dependsOnTaskId = parseId(request.params.dependsOnTaskId);
      removeDependency(db, id, dependsOnTaskId);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/tags",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(tagRefSchema, request.body);
      addTaskTag(db, id, body.tagId);
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/tasks/:id/tags/:tagId",
    async (request) => {
      const id = parseId(request.params.id);
      const tagId = parseId(request.params.tagId);
      removeTaskTag(db, id, tagId);
      return taskOrThrow(db, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/excluded-tags",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(tagRefSchema, request.body);
      addExcludedTag(db, id, body.tagId);
      reply.status(201);
      return taskOrThrow(db, id);
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/tasks/:id/excluded-tags/:tagId",
    async (request) => {
      const id = parseId(request.params.id);
      const tagId = parseId(request.params.tagId);
      removeExcludedTag(db, id, tagId);
      return taskOrThrow(db, id);
    },
  );
}

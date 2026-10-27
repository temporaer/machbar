import { createWithReceipt } from "../domain/creationReceipt.js";
import { previewActivation } from "../domain/activationPreview.js";
import { assertWorkItemAccessible } from "../domain/workItemShared.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { moveProject } from "../domain/structuralMoves.js";
import { moveProjectSchema } from "../schemas.js";
import { convertStoryToTask } from "../domain/roleConversion.js";
import {
  addCriterion,
  removeCriterion,
  reorderCriteria,
  setCriterionChecked,
  updateCriterionText,
} from "../domain/acceptanceCriteria.js";
import {
  appendProjectNotes,
  createProject,
  deleteProject,
  updateProject,
} from "../domain/storyCrud.js";
import {
  acknowledgeProjectReview,
  activateProject,
  archiveProject,
  completeProject,
  reopenProject,
  returnProjectToBacklog,
} from "../domain/storyWorkflow.js";
import {
  acknowledgeReviewSchema,
  activateProjectSchema,
  addCriterionSchema,
  appendNotesSchema,
  checkCriterionSchema,
  createProjectSchema,
  convertStoryToTaskSchema,
  projectLifecycleSchema,
  completeProjectSchema,
  reorderCriteriaSchema,
  returnProjectToBacklogSchema,
  updateCriterionSchema,
  updateProjectSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";
import { listExternalWorkItemRefs } from "../domain/externalWorkItemRefs.js";
import { projectActivationDecisionSnapshot } from "../domain/commitmentActivation.js";
import { createTaskStepBatchForProject } from "../domain/taskStepBatch.js";
import { taskStepBatchSchema } from "../schemas.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest(
      "identifier_invalid",
      "The project or criterion ID must be a number.",
      { resource: "project_or_criterion", value: raw },
    );
  }
  return id;
}

// See tasks.ts's identical helper: the authenticated member (or the
// activity actor) is the viewer used to hide other members' "work"-scope
// items, while still letting an owner's own items round-trip.
function viewerMemberId(request: FastifyRequest): number | undefined {
  return request.authMember?.id ?? request.activityActor?.id ?? undefined;
}

function projectOrThrow(db: Db, id: number, viewerMemberId?: number) {
  const graph = Graph.load(db, undefined, viewerMemberId);
  const project = graph.projectWithComputed(id);
  if (!project) {
    throw AppError.notFound(
      "project_not_found",
      "The requested project was not found.",
      { projectId: id },
    );
  }
  return { graph, project };
}

function projectWithIssues(graph: Graph, id: number) {
  return graph.projectWithComputed(id);
}

export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  app.addHook("preHandler", async (request) => {
    const path = request.routeOptions.url ?? "";
    if (!path.startsWith("/api/projects")) return;
    const viewer = viewerMemberId(request);
    const rawId = (request.params as { id?: string }).id;
    if (rawId !== undefined) assertWorkItemAccessible(db, parseId(rawId), viewer);
    const body = request.body as Record<string, unknown> | undefined;
    for (const field of ["parentTaskId", "projectId", "parentId", "dependsOnTaskId"]) {
      const id = body?.[field];
      if (typeof id === "number") assertWorkItemAccessible(db, id, viewer);
    }
  });

  app.get("/api/projects", async (request) => {
    const graph = Graph.load(db, undefined, viewerMemberId(request));
    return graph.listProjectsWithComputed();
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const { graph, project } = projectOrThrow(db, id, viewerMemberId(request));
    function attachRefs<T extends { id: number; children?: T[] }>(
      task: T,
    ): T & { externalRefs: ReturnType<typeof listExternalWorkItemRefs> } {
      return {
        ...task,
        externalRefs: listExternalWorkItemRefs(db, task.id),
        ...(task.children ? { children: task.children.map(attachRefs) } : {}),
      };
    }
    return {
      ...project,
      activationDecisionSnapshot: projectActivationDecisionSnapshot(db, id),
      directActivationDecisionSnapshot: projectActivationDecisionSnapshot(db, id, "explicit_activation"),
      externalRefs: listExternalWorkItemRefs(db, project.id),
      tasks: (graph.rootsByProject.get(id) ?? []).map(attachRefs),
    };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/tasks/batch", async (request, reply) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(taskStepBatchSchema, request.body);
    const mutate = () => createTaskStepBatchForProject(db, id, {
      ...body,
      ...(request.authMember ? { createdByMemberId: request.authMember.id } : {}),
    }, { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null });
    if (request.headers["x-machbar-preview"] === "activation") {
      reply.header("x-machbar-preview", "activation");
      return previewActivation(db, mutate, viewerMemberId(request), [id]);
    }
    const result = mutate();
    const graph = Graph.load(db, undefined, viewerMemberId(request));
    reply.status(201);
    return { tasks: result.tasks.map((task) => task.id).map((taskId) => {
      const task = graph.tasksById.get(taskId);
      if (!task) throw AppError.notFound("task_not_found", "The task was not found.", { taskId });
      return { ...task, ancestors: graph.taskAncestorsFor(taskId), externalRefs: listExternalWorkItemRefs(db, taskId) };
    }), project: graph.projectWithComputed(id) };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = parseOrThrow(createProjectSchema, request.body);
    const project = createWithReceipt(db, { key: request.headers["idempotency-key"], route: "/api/projects", viewer: viewerMemberId(request), body }, () => createProject(db, body, {
      actorMemberId: request.activityActor?.id ?? null,
      viewerMemberId: viewerMemberId(request) ?? null,
    }));
    if (project.replayed) reply.header("x-machbar-replay", "true");
    const graph = Graph.load(db, undefined, viewerMemberId(request));
    reply.status(project.replayed ? 200 : 201);
    const created = projectWithIssues(graph, project.id);
    if (!created) throw AppError.notFound("project_not_found", "The project was not found.", { projectId: project.id });
    return created;
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(updateProjectSchema, request.body);
    updateProject(db, id, body, {
      actorMemberId: request.activityActor?.id ?? null,
      viewerMemberId: viewerMemberId(request) ?? null,
    });
    const graph = Graph.load(db, undefined, viewerMemberId(request));
    return projectWithIssues(graph, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/notes",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(appendNotesSchema, request.body);
      appendProjectNotes(db, id, body.content, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { deleteTasks?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteProject(
        db,
        id,
        { deleteTasks: request.query.deleteTasks === "true" },
        {
          actorMemberId: request.activityActor?.id ?? null,
          viewerMemberId: viewerMemberId(request) ?? null,
        },
      );
      reply.status(204);
      return null;
    },
  );

  // --- explicit workflow transitions --------------------------------------
  // backlog <-> active -> completed <-> active, archive/return from
  // anywhere legal (see `availableProjectWorkflowActions` in mutations.ts).

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/activate",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(activateProjectSchema, request.body ?? {});
      activateProject(db, id, body, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/return-to-backlog",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(returnProjectToBacklogSchema, request.body ?? {});
      returnProjectToBacklog(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null },
        body.expectedRevision,
        body.revisitAt,
        body.withdrawCommitments,
        body.expectedTaskRevisions,
      );
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/complete",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(completeProjectSchema, request.body ?? {});
      completeProject(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null },
        body.expectedRevision,
        body,
      );
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/reopen",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(activateProjectSchema, request.body ?? {});
      reopenProject(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null },
        body.expectedRevision,
        body.ownerMemberId,
        body.activationResolution,
      );
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/archive",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(projectLifecycleSchema, request.body ?? {});
      archiveProject(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null },
        body.expectedRevision,
      );
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/convert-to-task",
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!Graph.load(db, undefined, viewerMemberId(request)).projectsById.has(id)) {
        throw AppError.notFound("project_not_found", "The project was not found.");
      }
      const body = parseOrThrow(convertStoryToTaskSchema, request.body ?? {});
      const task = convertStoryToTask(db, id, body, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      reply.status(201);
      return graph.allTasks().find((t) => t.id === task.id) ?? null;
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/move", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(moveProjectSchema, request.body);
    const visible = Graph.load(db, undefined, viewerMemberId(request));
    if (!visible.projectsById.has(id) || (body.parentId !== null && !visible.projectsById.has(body.parentId))) {
      throw AppError.notFound("project_not_found", "The project destination was not found.");
    }
    moveProject(db, id, body, { actorMemberId: request.activityActor?.id ?? null, viewerMemberId: viewerMemberId(request) ?? null });
    return projectWithIssues(Graph.load(db, undefined, viewerMemberId(request)), id);
  });

  // --- acceptance criteria (ordered, structured; replaces description) ---

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/criteria",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(addCriterionSchema, request.body);
      addCriterion(db, id, body.text, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      reply.status(201);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/criteria/reorder",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(reorderCriteriaSchema, request.body);
      reorderCriteria(db, id, body.orderedCriterionIds);
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.patch<{ Params: { id: string; criterionId: string } }>(
    "/api/projects/:id/criteria/:criterionId",
    async (request) => {
      const id = parseId(request.params.id);
      const criterionId = parseId(request.params.criterionId);
      const body = parseOrThrow(updateCriterionSchema, request.body);
      updateCriterionText(db, id, criterionId, body.text, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string; criterionId: string } }>(
    "/api/projects/:id/criteria/:criterionId/check",
    async (request) => {
      const id = parseId(request.params.id);
      const criterionId = parseId(request.params.criterionId);
      const body = parseOrThrow(checkCriterionSchema, request.body);
      setCriterionChecked(db, id, criterionId, body.checked, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.delete<{ Params: { id: string; criterionId: string } }>(
    "/api/projects/:id/criteria/:criterionId",
    async (request) => {
      const id = parseId(request.params.id);
      const criterionId = parseId(request.params.criterionId);
      removeCriterion(db, id, criterionId, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      const graph = Graph.load(db, undefined, viewerMemberId(request));
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/review",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(acknowledgeReviewSchema, request.body ?? {});
      acknowledgeProjectReview(db, id, body.expectedRevision, {
        actorMemberId: request.activityActor?.id ?? null,
        viewerMemberId: viewerMemberId(request) ?? null,
      });
      return projectWithIssues(Graph.load(db, undefined, viewerMemberId(request)), id);
    },
  );
}

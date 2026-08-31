import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import {
  acknowledgeProjectReview,
  activateProject,
  addCriterion,
  archiveProject,
  appendProjectNotes,
  completeProject,
  createProjectTaskSequence,
  createProject,
  deleteProject,
  removeCriterion,
  reopenProject,
  reorderCriteria,
  returnProjectToBacklog,
  setCriterionChecked,
  updateCriterionText,
  updateProject,
} from "../domain/mutations.js";
import {
  acknowledgeReviewSchema,
  activateProjectSchema,
  addCriterionSchema,
  appendNotesSchema,
  checkCriterionSchema,
  createProjectSchema,
  createTaskSequenceSchema,
  projectLifecycleSchema,
  reorderCriteriaSchema,
  updateCriterionSchema,
  updateProjectSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

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

function projectOrThrow(db: Db, id: number) {
  const graph = Graph.load(db);
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
  app.get("/api/projects", async () => {
    const graph = Graph.load(db);
    return graph.listProjectsWithComputed();
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const { graph, project } = projectOrThrow(db, id);
    return { ...project, tasks: graph.rootsByProject.get(id) ?? [] };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = parseOrThrow(createProjectSchema, request.body);
    const project = createProject(db, body, {
      actorMemberId: request.activityActor?.id ?? null,
    });
    const graph = Graph.load(db);
    reply.status(201);
    return projectWithIssues(graph, project.id);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(updateProjectSchema, request.body);
    updateProject(db, id, body, {
      actorMemberId: request.activityActor?.id ?? null,
    });
    const graph = Graph.load(db);
    return projectWithIssues(graph, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/notes",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(appendNotesSchema, request.body);
      appendProjectNotes(db, id, body.content, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/task-sequence",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(createTaskSequenceSchema, request.body);
      const created = createProjectTaskSequence(
        db,
        id,
        {
          ...body,
          ...(request.authMember
            ? { createdByMemberId: request.authMember.id }
            : {}),
        },
        { actorMemberId: request.activityActor?.id ?? null },
      );
      const graph = Graph.load(db);
      reply.status(201);
      return created.map((task) => graph.tasksById.get(task.id)!);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteProject(db, id, {
        actorMemberId: request.activityActor?.id ?? null,
      });
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
      });
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/return-to-backlog",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(projectLifecycleSchema, request.body ?? {});
      returnProjectToBacklog(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
      );
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/complete",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(projectLifecycleSchema, request.body ?? {});
      completeProject(
        db,
        id,
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
      );
      const graph = Graph.load(db);
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
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
        body.ownerMemberId,
      );
      const graph = Graph.load(db);
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
        { actorMemberId: request.activityActor?.id ?? null },
        body.expectedRevision,
      );
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  // --- acceptance criteria (ordered, structured; replaces description) ---

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/criteria",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(addCriterionSchema, request.body);
      addCriterion(db, id, body.text, {
        actorMemberId: request.activityActor?.id ?? null,
      });
      const graph = Graph.load(db);
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
      const graph = Graph.load(db);
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
      });
      const graph = Graph.load(db);
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
      });
      const graph = Graph.load(db);
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
      });
      const graph = Graph.load(db);
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
      });
      return projectWithIssues(Graph.load(db), id);
    },
  );
}

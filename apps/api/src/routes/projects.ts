import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import { buildRefinementIssues } from "../domain/refinementIssues.js";
import {
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
  activateProjectSchema,
  addCriterionSchema,
  appendNotesSchema,
  checkCriterionSchema,
  createProjectSchema,
  createTaskSequenceSchema,
  reorderCriteriaSchema,
  updateCriterionSchema,
  updateProjectSchema,
} from "../schemas.js";
import { parseOrThrow } from "../validation.js";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Die ID muss eine Zahl sein.");
  }
  return id;
}

function projectOrThrow(db: Db, id: number) {
  const graph = Graph.load(db);
  const project = graph.projectWithComputed(id);
  if (!project) {
    throw AppError.notFound(`Projekt mit ID ${id} wurde nicht gefunden.`);
  }
  const issues = buildRefinementIssues(graph).issues.filter(
    (issue) => issue.projectId === id,
  );
  return { graph, project: { ...project, refinementIssues: issues } };
}

function projectsWithIssues(graph: Graph) {
  const issues = buildRefinementIssues(graph).issues;
  return graph.listProjectsWithComputed().map((project) => ({
    ...project,
    refinementIssues: issues.filter((issue) => issue.projectId === project.id),
  }));
}

function projectWithIssues(graph: Graph, id: number) {
  return projectsWithIssues(graph).find((project) => project.id === id) ?? null;
}

export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/projects", async () => {
    const graph = Graph.load(db);
    return projectsWithIssues(graph);
  });

  app.get("/api/projects/stuck", async () => {
    const graph = Graph.load(db);
    const issues = buildRefinementIssues(graph).issues;
    return graph.listStuckProjects().map((project) => ({
      ...project,
      refinementIssues: issues.filter((issue) => issue.projectId === project.id),
    }));
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const { graph, project } = projectOrThrow(db, id);
    return { ...project, tasks: graph.rootsByProject.get(id) ?? [] };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = parseOrThrow(createProjectSchema, request.body);
    const project = createProject(db, body);
    const graph = Graph.load(db);
    reply.status(201);
    return projectWithIssues(graph, project.id);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = parseId(request.params.id);
    const body = parseOrThrow(updateProjectSchema, request.body);
    updateProject(db, id, body);
    const graph = Graph.load(db);
    return projectWithIssues(graph, id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/notes",
    async (request) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(appendNotesSchema, request.body);
      appendProjectNotes(db, id, body.content);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/task-sequence",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const body = parseOrThrow(createTaskSequenceSchema, request.body);
      const created = createProjectTaskSequence(db, id, {
        ...body,
        ...(request.authMember
          ? { createdByMemberId: request.authMember.id }
          : {}),
      });
      const graph = Graph.load(db);
      reply.status(201);
      return created.map((task) => graph.tasksById.get(task.id)!);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const id = parseId(request.params.id);
      deleteProject(db, id);
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
      activateProject(db, id, body);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/return-to-backlog",
    async (request) => {
      const id = parseId(request.params.id);
      returnProjectToBacklog(db, id);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/complete",
    async (request) => {
      const id = parseId(request.params.id);
      completeProject(db, id);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/reopen",
    async (request) => {
      const id = parseId(request.params.id);
      reopenProject(db, id);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/archive",
    async (request) => {
      const id = parseId(request.params.id);
      archiveProject(db, id);
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
      addCriterion(db, id, body.text);
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
      updateCriterionText(db, id, criterionId, body.text);
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
      setCriterionChecked(db, id, criterionId, body.checked);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );

  app.delete<{ Params: { id: string; criterionId: string } }>(
    "/api/projects/:id/criteria/:criterionId",
    async (request) => {
      const id = parseId(request.params.id);
      const criterionId = parseId(request.params.criterionId);
      removeCriterion(db, id, criterionId);
      const graph = Graph.load(db);
      return projectWithIssues(graph, id);
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";
import { Graph } from "../domain/graph.js";
import {
  archiveProject,
  createProject,
  getProjectOrThrow,
  unarchiveProject,
  updateProject,
} from "../domain/mutations.js";
import { createProjectSchema, updateProjectSchema } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/projects", async () => {
    const graph = Graph.load(db);
    return graph.listProjectsWithComputed();
  });

  app.get("/api/projects/stuck", async () => {
    const graph = Graph.load(db);
    return graph.listStuckProjects();
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = Number.parseInt(request.params.id, 10);
    const graph = Graph.load(db);
    const project = graph.projectWithComputed(id);
    if (!project) {
      throw AppError.notFound(`Projekt mit ID ${id} wurde nicht gefunden.`);
    }
    return { ...project, tasks: graph.rootsByProject.get(id) ?? [] };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = parseOrThrow(createProjectSchema, request.body);
    const project = createProject(db, body);
    const graph = Graph.load(db);
    reply.status(201);
    return graph.projectWithComputed(project.id);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const id = Number.parseInt(request.params.id, 10);
    const body = parseOrThrow(updateProjectSchema, request.body);
    updateProject(db, id, body);
    const graph = Graph.load(db);
    return graph.projectWithComputed(id);
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/archive",
    async (request) => {
      const id = Number.parseInt(request.params.id, 10);
      getProjectOrThrow(db, id);
      archiveProject(db, id);
      const graph = Graph.load(db);
      return graph.projectWithComputed(id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/unarchive",
    async (request) => {
      const id = Number.parseInt(request.params.id, 10);
      getProjectOrThrow(db, id);
      unarchiveProject(db, id);
      const graph = Graph.load(db);
      return graph.projectWithComputed(id);
    },
  );
}

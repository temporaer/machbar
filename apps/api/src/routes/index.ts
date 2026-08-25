import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { registerMemberRoutes } from "./members.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSearchRoutes } from "./search.js";
import { registerTagRoutes } from "./tags.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerViewRoutes } from "./views.js";

export function registerRoutes(app: FastifyInstance, db: Db) {
  registerMemberRoutes(app, db);
  registerTagRoutes(app, db);
  registerProjectRoutes(app, db);
  registerTaskRoutes(app, db);
  registerViewRoutes(app, db);
  registerSearchRoutes(app, db);
}

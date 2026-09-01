import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { registerActivityRoutes } from "./activity.js";
import { registerContributionRoutes } from "./contributions.js";
import { registerMemberRoutes } from "./members.js";
import { registerProjectRoutes } from "./projects.js";
import { registerRefinementRoutes } from "./refinement.js";
import { registerSearchRoutes } from "./search.js";
import { registerTagRoutes } from "./tags.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerViewRoutes } from "./views.js";
import { registerDebugRoutes } from "./debug.js";
import { registerPushRoutes } from "./push.js";
import type { Env } from "../env.js";
import type { PushTransport } from "../notifications/delivery.js";

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  pushTransport?: PushTransport,
) {
  registerActivityRoutes(app, db);
  registerContributionRoutes(app, db);
  registerMemberRoutes(app, db);
  registerTagRoutes(app, db);
  registerProjectRoutes(app, db);
  registerTaskRoutes(app, db);
  registerViewRoutes(app, db);
  registerSearchRoutes(app, db);
  registerRefinementRoutes(app, db);
  registerDebugRoutes(app, db);
  registerPushRoutes(app, db, env, pushTransport);
}

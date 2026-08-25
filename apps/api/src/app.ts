import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { AppError } from "./errors.js";
import { registerRoutes } from "./routes/index.js";
import { registerStatic } from "./static.js";

export interface BuildAppOptions {
  db: Db;
  env: Env;
  logger?: boolean;
}

/** Builds a fully configured Fastify instance. Used by both the production
 * server entrypoint and the integration tests (which pass an in-memory db). */
export function buildApp({ db, env, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }
    request.log.error(error);
    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Ein unerwarteter Fehler ist aufgetreten.",
      },
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  registerRoutes(app, db);
  registerStatic(app, env);

  return app;
}

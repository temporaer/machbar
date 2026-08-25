import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
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

  app.setErrorHandler<FastifyError | AppError>((error, request, reply) => {
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

    // Fastify itself throws typed errors (e.g. `FST_ERR_CTP_EMPTY_JSON_BODY`
    // when a request declares `Content-Type: application/json` but sends no
    // body) before any route handler runs, so they never become `AppError`s.
    // These already carry a genuine 4xx `statusCode` from Fastify — treat
    // that as authoritative and reply with a calm, generic German message
    // instead of falling through to the 500 branch below, but without
    // echoing Fastify's own (English, internals-revealing) error message.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn(error);
      reply.status(error.statusCode).send({
        error: {
          code: "bad_request",
          message: "Die Anfrage konnte nicht verarbeitet werden.",
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

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { AppError } from "./errors.js";
import { registerRoutes } from "./routes/index.js";
import { registerStatic } from "./static.js";
import { registerAuthentication } from "./auth/routes.js";
import type { OidcProvider } from "./auth/oidcClient.js";
import { registerActivityActorResolution } from "./activity/actor.js";
import {
  ChangeNotifier,
  registerChangeNotifications,
} from "./changeNotifier.js";
import {
  registerNotificationRunner,
} from "./notifications/runner.js";
import {
  createWebPushTransport,
  type PushTransport,
} from "./notifications/delivery.js";
import {
  createPaperlessClient,
  type PaperlessClient,
} from "./paperless/client.js";

export interface BuildAppOptions {
  db: Db;
  env: Env;
  logger?: boolean;
  oidcProvider?: OidcProvider;
  changeNotifier?: ChangeNotifier;
  pushTransport?: PushTransport;
  paperlessClient?: PaperlessClient;
}

/** Builds a fully configured Fastify instance. Used by both the production
 * server entrypoint and the integration tests (which pass an in-memory db). */
export function buildApp({
  db,
  env,
  logger = false,
  oidcProvider,
  changeNotifier,
  pushTransport,
  paperlessClient,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const notificationTransport =
    pushTransport ??
    (env.push ? createWebPushTransport(env.push) : undefined);
  const paperless =
    paperlessClient ??
    (env.paperless ? createPaperlessClient(env.paperless) : undefined);

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
    // that as authoritative and reply with a generic fallback message
    // instead of falling through to the 500 branch below, but without
    // echoing Fastify's own (English, internals-revealing) error message.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn(error);
      reply.status(error.statusCode).send({
        error: {
          code: "malformed_request",
          message: "The request could not be processed.",
          details: { fastifyCode: error.code },
        },
      });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  registerAuthentication(app, db, env, { provider: oidcProvider });
  registerActivityActorResolution(app, db, env);
  registerChangeNotifications(app, changeNotifier ?? new ChangeNotifier());
  registerRoutes(app, db, env, notificationTransport, paperless);
  registerNotificationRunner(app, db, env.push, notificationTransport);
  registerStatic(app, env);

  return app;
}

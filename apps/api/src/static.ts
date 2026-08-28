import fs from "node:fs";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { Env } from "./env.js";

/**
 * Serves the built web app (apps/web/dist) under the configurable
 * BASE_PATH, when that directory exists. In development the web app is
 * usually served by its own dev server, so a missing dist directory is
 * not an error — the API simply serves API routes and falls back to a
 * plain JSON 404 for everything else.
 */
export function registerStatic(app: FastifyInstance, env: Env) {
  const hasWebBuild = fs.existsSync(env.webDistDir);

  if (hasWebBuild) {
    const prefix = env.basePath === "/" ? "/" : `${env.basePath}/`;
    app.register(fastifyStatic, {
      root: env.webDistDir,
      prefix,
      decorateReply: true,
    });
  }

  // SPA fallback: any non-API GET request under BASE_PATH that isn't a
  // known static asset resolves to index.html so client-side routing
  // works; everything else (API routes, other methods, paths outside
  // BASE_PATH) gets a stable JSON 404.
  app.setNotFoundHandler((request, reply) => {
    const isApiRequest = request.url.startsWith("/api/");
    const isUnderBasePath =
      env.basePath === "/" ||
      request.url === env.basePath ||
      request.url.startsWith(`${env.basePath}/`);
    if (hasWebBuild && request.method === "GET" && !isApiRequest && isUnderBasePath) {
      reply.sendFile("index.html", env.webDistDir);
      return;
    }
    reply.status(404).send({
      error: {
        code: "route_not_found",
        message: "The requested resource was not found.",
        details: { method: request.method, path: request.url.split("?", 1)[0] },
      },
    });
  });
}

import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import { PocketIdProvider, type OidcProvider } from "./oidcClient.js";
import { AuthService } from "./service.js";

export const SESSION_COOKIE = "__Host-machbar-session";
export const OIDC_STATE_COOKIE = "__Host-machbar-oidc-state";

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
}).refine((value) => value.code || value.error, {
  message: "Code oder Fehler fehlt.",
});

const loginQuerySchema = z.object({
  returnTo: z.string().optional(),
});

function requestPath(url: string): string {
  return url.split("?", 1)[0]!;
}

function isPublicApiPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/auth/status" ||
    path === "/api/auth/login" ||
    path === "/api/auth/callback"
  );
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

export function validateReturnTo(input: string | undefined, basePath: string): string {
  const appPath = basePath === "/" ? "/" : `${basePath}/`;
  if (!input) return `${appPath}#/heute`;
  if (!input.startsWith("/") || input.startsWith("//") || /[\r\n]/.test(input)) {
    throw AppError.badRequest("Das Anmeldeziel ist ungültig.");
  }
  const parsed = new URL(input, "https://machbar.invalid");
  if (
    parsed.origin !== "https://machbar.invalid" ||
    (parsed.pathname !== basePath && parsed.pathname !== appPath) ||
    !parsed.hash.startsWith("#/")
  ) {
    throw AppError.badRequest("Das Anmeldeziel ist ungültig.");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function cookieOptions(expires?: Date) {
  return {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    ...(expires
      ? {
          expires,
          maxAge: Math.max(
            0,
            Math.floor((expires.getTime() - Date.now()) / 1000),
          ),
        }
      : {}),
  };
}

function oidcStateCookieOptions() {
  return {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 10 * 60,
  };
}

function authErrorRedirect(publicUrl: string, message: string): string {
  const url = new URL(publicUrl);
  url.searchParams.set("authError", message);
  url.hash = "/heute";
  return url.toString();
}

export interface RegisterAuthenticationOptions {
  provider?: OidcProvider;
}

export function registerAuthentication(
  app: FastifyInstance,
  db: Db,
  env: Env,
  options: RegisterAuthenticationOptions = {},
): void {
  app.register(cookie);
  app.decorateRequest("authMember", null);

  const service =
    env.oidc === null
      ? null
      : new AuthService(
          db,
          env.oidc,
          options.provider ?? new PocketIdProvider(env.oidc),
        );

  app.addHook("onRequest", async (request) => {
    request.authMember = service?.memberForSession(
      request.cookies[SESSION_COOKIE],
    ) ?? null;
    if (!service) return;

    const path = requestPath(request.url);
    if (path.startsWith("/api/") && !isPublicApiPath(path) && !request.authMember) {
      throw AppError.unauthorized("Bitte zuerst mit Pocket ID anmelden.");
    }
    if (
      path.startsWith("/api/") &&
      isUnsafeMethod(request.method) &&
      request.headers.origin !== env.oidc!.publicUrl
    ) {
      throw AppError.forbidden("Die Anfrage stammt nicht von der Machbar-App.");
    }
  });

  app.get("/api/auth/status", async (request) => ({
    enabled: service !== null,
    authenticated: request.authMember !== null,
    member: request.authMember,
  }));

  app.get("/api/auth/login", async (request, reply) => {
    if (!service || !env.oidc) {
      throw AppError.notFound("Pocket-ID-Anmeldung ist nicht konfiguriert.");
    }
    const query = parseOrThrow(loginQuerySchema, request.query);
    const returnTo = validateReturnTo(query.returnTo, env.basePath);
    const login = await service.beginLogin(returnTo);
    reply.setCookie(
      OIDC_STATE_COOKIE,
      login.correlationState,
      oidcStateCookieOptions(),
    );
    return reply.redirect(login.authorizationUrl.toString());
  });

  app.get("/api/auth/callback", async (request, reply) => {
    if (!service || !env.oidc) {
      throw AppError.notFound("Pocket-ID-Anmeldung ist nicht konfiguriert.");
    }
    const query = parseOrThrow(callbackQuerySchema, request.query);
    const correlationState = request.cookies[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, oidcStateCookieOptions());
    if (!correlationState || correlationState !== query.state) {
      return reply.redirect(
        authErrorRedirect(
          env.oidc.publicUrl,
          "Die Anmeldung gehört nicht zu diesem Browser. Bitte erneut anmelden.",
        ),
      );
    }
    if (query.error) {
      service.cancelLogin(query.state);
      return reply.redirect(
        authErrorRedirect(
          env.oidc.publicUrl,
          query.error_description?.trim() ||
            "Die Anmeldung bei Pocket ID wurde abgebrochen.",
        ),
      );
    }
    const callbackUrl = new URL(request.url, env.oidc.publicUrl);
    let login;
    try {
      login = await service.completeLogin(callbackUrl, query.state);
    } catch (cause) {
      if (cause instanceof AppError) {
        return reply.redirect(
          authErrorRedirect(env.oidc.publicUrl, cause.message),
        );
      }
      throw cause;
    }
    reply.setCookie(
      SESSION_COOKIE,
      login.sessionToken,
      cookieOptions(login.sessionExpiresAt),
    );
    return reply.redirect(`${env.oidc.publicUrl}${login.returnTo}`);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (!service) {
      throw AppError.notFound("Pocket-ID-Anmeldung ist nicht konfiguriert.");
    }
    service.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    reply.status(204);
    return null;
  });
}

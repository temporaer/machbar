import cookie from "@fastify/cookie";
import type { ApiErrorCode } from "@machbar/shared";
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
  message: "Code or error is required.",
});

const loginQuerySchema = z.object({
  returnTo: z.string().optional(),
});

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
    throw AppError.badRequest(
      "auth_return_target_invalid",
      "The sign-in return target is invalid.",
      { returnTo: input },
    );
  }
  const parsed = new URL(input, "https://machbar.invalid");
  if (
    parsed.origin !== "https://machbar.invalid" ||
    (parsed.pathname !== basePath && parsed.pathname !== appPath) ||
    !parsed.hash.startsWith("#/")
  ) {
    throw AppError.badRequest(
      "auth_return_target_invalid",
      "The sign-in return target is invalid.",
      { returnTo: input },
    );
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

function authErrorRedirect(
  publicUrl: string,
  basePath: string,
  code: ApiErrorCode,
  details?: Record<string, unknown>,
): string {
  const appPath = basePath === "/" ? "/" : `${basePath}/`;
  const url = new URL(appPath, publicUrl);
  url.searchParams.set("authErrorCode", code);
  if (details !== undefined) {
    url.searchParams.set("authErrorDetails", JSON.stringify(details));
  }
  url.hash = "/today";
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
  });

  app.addHook("preHandler", async (request) => {
    if (!service) return;

    const routePath = request.routeOptions.url;
    if (!routePath?.startsWith("/api/")) return;

    if (
      !isPublicApiPath(routePath) &&
      !request.authMember
    ) {
      throw AppError.unauthorized(
        "authentication_required",
        "Sign in with Pocket ID before accessing this resource.",
      );
    }
    if (
      isUnsafeMethod(request.method) &&
      request.headers.origin !== env.oidc!.publicUrl
    ) {
      throw AppError.forbidden(
        "request_origin_forbidden",
        "The request origin is not allowed.",
        { origin: request.headers.origin ?? null },
      );
    }
  });

  app.get("/api/auth/status", async (request) => ({
    enabled: service !== null,
    authenticated: request.authMember !== null,
    member: request.authMember,
  }));

  app.get("/api/auth/login", async (request, reply) => {
    if (!service || !env.oidc) {
      throw AppError.notFound(
        "oidc_not_configured",
        "Pocket ID sign-in is not configured.",
      );
    }
    const query = parseOrThrow(loginQuerySchema, request.query, {
      code: "auth_query_invalid",
      message: "The authentication query parameters are invalid.",
    });
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
      throw AppError.notFound(
        "oidc_not_configured",
        "Pocket ID sign-in is not configured.",
      );
    }
    const query = parseOrThrow(callbackQuerySchema, request.query, {
      code: "auth_query_invalid",
      message: "The authentication query parameters are invalid.",
    });
    const correlationState = request.cookies[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, oidcStateCookieOptions());
    if (!correlationState || correlationState !== query.state) {
      return reply.redirect(
        authErrorRedirect(
          env.oidc.publicUrl,
          env.basePath,
          "oidc_browser_mismatch",
        ),
      );
    }
    if (query.error) {
      service.cancelLogin(query.state);
      return reply.redirect(
        authErrorRedirect(
          env.oidc.publicUrl,
          env.basePath,
          "oidc_provider_error",
          {
            providerCode: query.error,
          },
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
          authErrorRedirect(
            env.oidc.publicUrl,
            env.basePath,
            cause.code,
          ),
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
      throw AppError.notFound(
        "oidc_not_configured",
        "Pocket ID sign-in is not configured.",
      );
    }
    service.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    reply.status(204);
    return null;
  });
}

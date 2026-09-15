import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { Member } from "@machbar/shared";
import type { Db } from "../db/client.js";
import type { McpOAuthConfig, OidcConfig } from "../env.js";
import { AppError } from "../errors.js";
import { findOidcMemberByIdentity } from "../auth/repository.js";

const JWT_CLOCK_TOLERANCE_SECONDS = 60;
const PROVIDER_UNAVAILABLE_JOSE_CODES = new Set([
  "ERR_JOSE_GENERIC",
  "ERR_JWK_INVALID",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT",
]);

export interface McpOAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface McpOAuthProviderOptions {
  discover?: (issuerUrl: string) => Promise<McpOAuthMetadata>;
}

interface DiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  jwks_uri?: unknown;
}

function requiredString(
  document: DiscoveryDocument,
  field: keyof DiscoveryDocument,
): string {
  const value = document[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Pocket ID discovery is missing ${field}.`);
  }
  return value;
}

function requiredHttpsUrl(
  document: DiscoveryDocument,
  field: keyof DiscoveryDocument,
): string {
  const value = requiredString(document, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Pocket ID discovery has an invalid ${field}.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Pocket ID discovery requires an HTTPS ${field}.`);
  }
  return value;
}

async function discoverPocketId(issuerUrl: string): Promise<McpOAuthMetadata> {
  const discoveryUrl = new URL(
    ".well-known/openid-configuration",
    `${issuerUrl.replace(/\/$/, "")}/`,
  );
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`Pocket ID discovery failed with HTTP ${response.status}.`);
  }
  const document = (await response.json()) as DiscoveryDocument;
  const issuer = requiredString(document, "issuer");
  if (issuer !== issuerUrl) {
    throw new Error("Pocket ID discovery issuer does not match configuration.");
  }
  return {
    issuer,
    authorizationEndpoint: requiredHttpsUrl(
      document,
      "authorization_endpoint",
    ),
    tokenEndpoint: requiredHttpsUrl(document, "token_endpoint"),
    jwksUri: requiredHttpsUrl(document, "jwks_uri"),
  };
}

function invalidToken(): AppError {
  return AppError.unauthorized(
    "mcp_oauth_invalid_token",
    "The MCP OAuth access token is invalid.",
  );
}

function providerUnavailable(): AppError {
  return new AppError(
    503,
    "mcp_oauth_provider_unavailable",
    "The MCP OAuth identity provider is temporarily unavailable.",
  );
}

function isProviderUnavailable(error: unknown): boolean {
  return !(
    error instanceof errors.JOSEError &&
    !PROVIDER_UNAVAILABLE_JOSE_CODES.has(error.code)
  );
}

export class McpOAuthProvider {
  private metadataPromise: Promise<McpOAuthMetadata> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksUri: string | null = null;

  constructor(
    private readonly oidc: OidcConfig,
    private readonly oauth: McpOAuthConfig,
    private readonly options: McpOAuthProviderOptions = {},
  ) {}

  metadata(): Promise<McpOAuthMetadata> {
    if (!this.metadataPromise) {
      this.metadataPromise = (
        this.options.discover?.(this.oidc.issuerUrl) ??
        discoverPocketId(this.oidc.issuerUrl)
      ).catch((cause: unknown) => {
        this.metadataPromise = null;
        throw cause;
      });
    }
    return this.metadataPromise;
  }

  private async jwksFor(uri: string) {
    if (!this.jwks || this.jwksUri !== uri) {
      this.jwks = createRemoteJWKSet(new URL(uri));
      this.jwksUri = uri;
    }
    return this.jwks;
  }

  async authenticate(
    db: Db,
    token: string,
  ): Promise<{ member: Member; scope: "household"; agentId: null }> {
    let metadata: McpOAuthMetadata;
    try {
      metadata = await this.metadata();
    } catch {
      throw providerUnavailable();
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, await this.jwksFor(metadata.jwksUri), {
        issuer: this.oidc.issuerUrl,
        audience: this.oauth.resourceUrl,
        requiredClaims: ["exp"],
        clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      });
      payload = verified.payload;
    } catch (error) {
      if (isProviderUnavailable(error)) {
        throw providerUnavailable();
      }
      throw invalidToken();
    }

    if (typeof payload.sub !== "string" || !payload.sub.trim()) {
      throw invalidToken();
    }
    const scopes = new Set(
      typeof payload.scope === "string"
        ? payload.scope.split(/\s+/).filter(Boolean)
        : [],
    );
    if (!scopes.has(this.oauth.requiredScope)) {
      throw AppError.forbidden(
        "mcp_oauth_insufficient_scope",
        "The MCP OAuth access token lacks the required household scope.",
      );
    }

    const member = findOidcMemberByIdentity(
      db,
      this.oidc.issuerUrl,
      payload.sub,
    );
    if (!member) {
      throw AppError.forbidden(
        "mcp_oauth_member_unlinked",
        "The Pocket ID identity is not linked to an existing Machbar member.",
      );
    }
    return { member, scope: "household", agentId: null };
  }
}

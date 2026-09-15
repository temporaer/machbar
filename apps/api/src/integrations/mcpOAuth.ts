import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Member } from "@machbar/shared";
import type { Db } from "../db/client.js";
import type { McpOAuthConfig, OidcConfig } from "../env.js";
import { AppError } from "../errors.js";
import {
  findOidcMemberByIdentity,
} from "../auth/repository.js";

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
  return {
    issuer: requiredString(document, "issuer"),
    authorizationEndpoint: requiredString(document, "authorization_endpoint"),
    tokenEndpoint: requiredString(document, "token_endpoint"),
    jwksUri: requiredString(document, "jwks_uri"),
  };
}

function invalidToken(): AppError {
  return AppError.unauthorized(
    "mcp_oauth_invalid_token",
    "The MCP OAuth access token is invalid.",
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
      throw invalidToken();
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, await this.jwksFor(metadata.jwksUri), {
        issuer: this.oidc.issuerUrl,
        audience: this.oauth.resourceUrl,
        requiredClaims: ["exp"],
        clockTolerance: 60,
      });
      payload = verified.payload;
    } catch {
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

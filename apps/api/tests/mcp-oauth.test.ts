import { createServer, type Server } from "node:http";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "../src/db/schema.js";
import { McpOAuthProvider } from "../src/integrations/mcpOAuth.js";
import type { OidcConfig } from "../src/env.js";
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from "./helpers.js";

const oidc: OidcConfig = {
  issuerUrl: "https://pocket.example",
  clientId: "machbar",
  clientSecret: "secret",
  publicUrl: "https://machbar.example",
  sessionTtlDays: 30,
};
const mcpOAuth = {
  resourceUrl: "https://machbar.example/api/mcp",
  requiredScope: "machbar:mcp:household" as const,
};

let privateKey: Parameters<SignJWT["sign"]>[0];
let jwks: Record<string, unknown>;
let jwksServer: Server;
let jwksUri: string;
let jwksAvailable = true;

beforeAll(async () => {
  const generated = await generateKeyPair("RS256");
  privateKey = generated.privateKey;
  jwks = {
    keys: [
      {
        ...(await exportJWK(generated.publicKey)),
        kid: "mcp-test",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  jwksServer = createServer((request, response) => {
    if (request.url !== "/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    if (!jwksAvailable) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address();
  if (!address || typeof address === "string") {
    throw new Error("The test JWKS server did not expose a port.");
  }
  jwksUri = `http://127.0.0.1:${address.port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    jwksServer.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("MCP OAuth", () => {
  let ctx: TestContext;
  let provider: McpOAuthProvider;

  beforeEach(() => {
    provider = new McpOAuthProvider(oidc, mcpOAuth, {
      discover: async () => ({
        issuer: oidc.issuerUrl,
        authorizationEndpoint: "https://pocket.example/authorize",
        tokenEndpoint: "https://pocket.example/token",
        jwksUri,
      }),
    });
    ctx = createTestContext({
      oidc,
      mcpOAuth,
      mcpOAuthProvider: provider,
    });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function token(
    overrides: {
      audience?: string | string[];
      subject?: string | null;
      scope?: unknown;
      issuer?: string;
      expiration?: number | string | null;
      signingKey?: Parameters<SignJWT["sign"]>[0];
    } = {},
  ) {
    const builder = new SignJWT(
      !Object.prototype.hasOwnProperty.call(overrides, "scope")
        ? {
            scope: "openid offline_access machbar:mcp:household",
          }
        : { scope: overrides.scope },
    )
      .setProtectedHeader({ alg: "RS256", kid: "mcp-test" })
      .setIssuer(overrides.issuer ?? oidc.issuerUrl)
      .setAudience(overrides.audience ?? mcpOAuth.resourceUrl);
    if (overrides.expiration !== null) {
      builder.setExpirationTime(overrides.expiration ?? "10m");
    }
    if (overrides.subject !== null) {
      builder.setSubject(overrides.subject ?? "subject-hannes");
    }
    return builder.sign(overrides.signingKey ?? privateKey);
  }

  async function createLinkedMember(subject = "subject-hannes") {
    const member = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Mira", color: "" })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.memberOidcIdentities)
      .values({
        issuer: oidc.issuerUrl,
        subject,
        memberId: member.id,
      })
      .run();
    return member;
  }

  function mcpRequest(
    authorization: string | undefined,
    id: number,
    method: string,
    params: Record<string, unknown> = {},
  ) {
    return ctx.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        ...(authorization ? { authorization } : {}),
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id,
        method,
        params,
      },
    });
  }

  function oauthAuthorization(tokenValue: string): string {
    return ["Bearer", tokenValue].join(" ");
  }

  it("publishes protected-resource and compatibility metadata", async () => {
    const protectedMetadata = await ctx.app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/api/mcp",
    });
    expect(protectedMetadata.json()).toEqual({
      resource: mcpOAuth.resourceUrl,
      authorization_servers: [oidc.publicUrl],
      scopes_supported: ["openid", "offline_access", mcpOAuth.requiredScope],
    });
    const fallbackMetadata = await ctx.app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(fallbackMetadata.json()).toEqual(protectedMetadata.json());

    const authorizationServer = await ctx.app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(authorizationServer.json()).toMatchObject({
      issuer: oidc.publicUrl,
      authorization_endpoint: `${oidc.publicUrl}/api/mcp/oauth/authorize`,
      token_endpoint: "https://pocket.example/token",
    });
    expect(
      ctx.app.hasRoute({
        method: "POST",
        url: "/api/mcp/oauth/token",
      }),
    ).toBe(false);
  });

  it("preserves authorization parameters while forcing the canonical resource", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url:
        "/api/mcp/oauth/authorize?response_type=code&client_id=ha-client" +
        "&redirect_uri=https%3A%2F%2Fmy.home-assistant.io%2Fredirect%2Foauth" +
        "&state=test-state&scope=openid%20offline_access&resource=https%3A%2F%2Fevil.example",
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location!);
    expect(location.origin).toBe("https://pocket.example");
    expect(location.searchParams.get("client_id")).toBe("ha-client");
    expect(location.searchParams.get("state")).toBe("test-state");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://my.home-assistant.io/redirect/oauth",
    );
    expect(location.searchParams.getAll("resource")).toEqual([
      mcpOAuth.resourceUrl,
    ]);
  });

  it("challenges missing and invalid credentials", async () => {
    const missing = await mcpRequest(undefined, 1, "initialize");
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain(
      'resource_metadata="https://machbar.example/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(missing.headers["www-authenticate"]).not.toContain("error=");

    const invalid = await mcpRequest("Bearer not-a-jwt", 2, "initialize");
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );
  });

  it("accepts a linked household token through the real MCP endpoint", async () => {
    const member = await createLinkedMember();
    const householdTask = ctx.handle.db
      .insert(schema.workItems)
      .values({
        title: "Household task",
        role: "task",
        status: "active",
      })
      .returning()
      .get();
    ctx.handle.db
      .insert(schema.workItems)
      .values({
        title: "Work task",
        role: "task",
        status: "active",
        scope: "work",
        ownerMemberId: member.id,
        ownerInheritanceMode: "explicit",
      })
      .run();
    const authorization = `Bearer ${await token({
      audience: ["ha-client", mcpOAuth.resourceUrl],
    })}`;

    expect((await mcpRequest(authorization, 1, "initialize")).statusCode).toBe(
      200,
    );
    const tools = await mcpRequest(authorization, 2, "tools/list");
    expect(tools.statusCode).toBe(200);
    const today = await mcpRequest(authorization, 3, "tools/call", {
      name: "machbar_today",
      arguments: { date: "2026-09-15" },
    });
    expect(today.statusCode).toBe(200);
    expect(JSON.stringify(today.json())).toContain(householdTask.title);
    expect(JSON.stringify(today.json())).not.toContain("Work task");
  });

  it("accepts a token expired within the clock-skew tolerance", async () => {
    await createLinkedMember();
    const response = await mcpRequest(
      oauthAuthorization(await token({
        expiration: Math.floor(Date.now() / 1000) - 30,
      })),
      1,
      "initialize",
    );
    expect(response.statusCode).toBe(200);
  });

  it("creates a household task through the OAuth MCP write path", async () => {
    const member = await createLinkedMember();
    const title = "OAuth-created household task";
    const response = await mcpRequest(
      oauthAuthorization(await token()),
      1,
      "tools/call",
      {
        name: "machbar_create_task",
        arguments: {
          title,
          status: "actionable",
        },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent.result).toEqual(
      expect.objectContaining({
        title,
        effectiveOwnerId: null,
      }),
    );
    const created = ctx.handle.db
      .select()
      .from(schema.workItems)
      .all()
      .find((item) => item.title === title);
    expect(created).toEqual(
      expect.objectContaining({
        title,
        scope: "household",
        createdByMemberId: member.id,
      }),
    );
  });

  it("rejects insufficient scope, wrong audience, and unlinked subjects", async () => {
    await createLinkedMember();
    const insufficient = await mcpRequest(
      `Bearer ${await token({ scope: "openid" })}`,
      1,
      "initialize",
    );
    expect(insufficient.statusCode).toBe(403);
    expect(insufficient.json().error.code).toBe("mcp_oauth_insufficient_scope");
    expect(insufficient.headers["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );

    const wrongAudience = await mcpRequest(
      `Bearer ${await token({ audience: "ha-client" })}`,
      2,
      "initialize",
    );
    expect(wrongAudience.statusCode).toBe(401);
    expect(wrongAudience.json().error.code).toBe("mcp_oauth_invalid_token");

    const unlinked = await mcpRequest(
      `Bearer ${await token({ subject: "unknown-subject" })}`,
      3,
      "initialize",
    );
    expect(unlinked.statusCode).toBe(403);
    expect(unlinked.json().error.code).toBe("mcp_oauth_member_unlinked");
    expect(unlinked.headers["www-authenticate"]).toBeUndefined();
  });

  it("returns 503 without an invalid-token challenge when discovery fails", async () => {
    const failedProvider = new McpOAuthProvider(oidc, mcpOAuth, {
      discover: async () => {
        throw new Error("Pocket ID is unavailable");
      },
    });
    const failedContext = createTestContext({
      oidc,
      mcpOAuth,
      mcpOAuthProvider: failedProvider,
    });
    try {
      const response = await failedContext.app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          authorization: oauthAuthorization(await token()),
          accept: "application/json, text/event-stream",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe(
        "mcp_oauth_provider_unavailable",
      );
      expect(response.headers["www-authenticate"]).toBeUndefined();
    } finally {
      await closeTestContext(failedContext);
    }
  });

  it("returns 503 without an invalid-token challenge when JWKS retrieval fails", async () => {
    await createLinkedMember();
    jwksAvailable = false;
    try {
      const response = await mcpRequest(
        oauthAuthorization(await token()),
        1,
        "initialize",
      );
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe(
        "mcp_oauth_provider_unavailable",
      );
      expect(response.headers["www-authenticate"]).toBeUndefined();
    } finally {
      jwksAvailable = true;
    }
  });

  it("rejects discovery metadata with a mismatched issuer or insecure endpoint", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: "https://other.example",
          authorization_endpoint: "https://pocket.example/authorize",
          token_endpoint: "https://pocket.example/token",
          jwks_uri: "https://pocket.example/jwks.json",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const discoveryProvider = new McpOAuthProvider(oidc, mcpOAuth);
      await expect(discoveryProvider.metadata()).rejects.toThrow(
        "issuer does not match",
      );

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            issuer: oidc.issuerUrl,
            authorization_endpoint: "http://pocket.example/authorize",
            token_endpoint: "https://pocket.example/token",
            jwks_uri: "https://pocket.example/jwks.json",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const insecureProvider = new McpOAuthProvider(oidc, mcpOAuth);
      await expect(insecureProvider.metadata()).rejects.toThrow(
        "requires an HTTPS",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed for invalid signatures, expiry, issuer, subject, and scope claims", async () => {
    await createLinkedMember();
    const otherKey = (await generateKeyPair("RS256")).privateKey;
    const cases = [
      { name: "wrong signature", options: { signingKey: otherKey } },
      {
        name: "expired token",
        options: { expiration: Math.floor(Date.now() / 1000) - 61 },
      },
      { name: "missing expiration", options: { expiration: null } },
      { name: "wrong issuer", options: { issuer: "https://other.example" } },
      { name: "missing subject", options: { subject: null } },
      {
        name: "missing scope",
        options: { scope: undefined },
        expectedStatus: 403,
      },
      {
        name: "malformed scope",
        options: { scope: ["machbar:mcp:household"] },
        expectedStatus: 403,
      },
    ];
    for (const testCase of cases) {
      const response = await mcpRequest(
        `Bearer ${await token(testCase.options)}`,
        1,
        "initialize",
      );
      expect(response.statusCode, testCase.name).toBe(
        testCase.expectedStatus ?? 401,
      );
      if ((testCase.expectedStatus ?? 401) === 401) {
        expect(response.json().error.code, testCase.name).toBe(
          "mcp_oauth_invalid_token",
        );
      }
    }
  });

  it("does not reinterpret an invalid static token as OAuth", async () => {
    const response = await mcpRequest("Bearer mbmcp_revoked", 1, "initialize");
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("integration_token_revoked");
  });
});

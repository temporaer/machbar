import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import { MCP_HOUSEHOLD_SCOPE } from "../env.js";
import type { McpOAuthProvider } from "../integrations/mcpOAuth.js";

function protectedResourceMetadata(env: Env) {
  const resourceUrl = env.mcpOAuth!.resourceUrl;
  return {
    resource: resourceUrl,
    authorization_servers: [env.oidc!.publicUrl],
    scopes_supported: ["openid", "offline_access", MCP_HOUSEHOLD_SCOPE],
  };
}

export function registerMcpOAuthRoutes(
  app: FastifyInstance,
  env: Env,
  provider: McpOAuthProvider | undefined,
): void {
  if (!env.mcpOAuth || !env.oidc || !provider) return;

  const metadata = () => protectedResourceMetadata(env);
  app.get("/.well-known/oauth-protected-resource", metadata);
  app.get("/.well-known/oauth-protected-resource/api/mcp", metadata);

  // Temporary Home Assistant compatibility: current HA omits RFC 8707
  // resource=, so this route injects only the canonical Machbar resource.
  app.get("/.well-known/oauth-authorization-server", async () => {
    const discovered = await provider.metadata();
    return {
      issuer: env.oidc!.publicUrl,
      authorization_endpoint: `${env.oidc!.publicUrl}/api/mcp/oauth/authorize`,
      token_endpoint: discovered.tokenEndpoint,
      scopes_supported: ["openid", "offline_access", MCP_HOUSEHOLD_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };
  });

  app.get("/api/mcp/oauth/authorize", async (request, reply) => {
    const discovered = await provider.metadata();
    const target = new URL(discovered.authorizationEndpoint);
    const incoming = new URL(request.url, env.oidc!.publicUrl);
    for (const [key, value] of incoming.searchParams) {
      target.searchParams.append(key, value);
    }
    target.searchParams.set("resource", env.mcpOAuth!.resourceUrl);
    return reply.redirect(target.toString());
  });
}

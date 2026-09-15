import type { ActivityActor, Member, WorkItemScope } from "@machbar/shared";

declare module "fastify" {
  interface FastifyRequest {
    authMember: Member | null;
    homeAssistantIntegrationId: number | null;
    mcpAgentId: number | null;
    mcpScope: WorkItemScope | null;
    activityActor: ActivityActor | null;
  }
}

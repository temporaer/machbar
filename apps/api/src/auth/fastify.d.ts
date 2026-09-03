import type { ActivityActor, Member } from "@machbar/shared";

declare module "fastify" {
  interface FastifyRequest {
    authMember: Member | null;
    homeAssistantIntegrationId: number | null;
    activityActor: ActivityActor | null;
  }
}

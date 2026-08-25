import type { Member } from "@machbar/shared";

declare module "fastify" {
  interface FastifyRequest {
    authMember: Member | null;
  }
}

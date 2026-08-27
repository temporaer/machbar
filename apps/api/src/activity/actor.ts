import { eq } from "drizzle-orm";
import {
  ACTIVITY_ACTOR_HEADER,
  type ActivityActor,
  type Member,
} from "@machbar/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";

function parseActorMemberId(value: string | string[]): number {
  if (Array.isArray(value) || !/^[1-9]\d*$/.test(value)) {
    throw AppError.badRequest(
      "Die ausgewählte Aktivitäts-Person muss eine gültige Mitglieds-ID sein.",
    );
  }
  const memberId = Number(value);
  if (!Number.isSafeInteger(memberId)) {
    throw AppError.badRequest(
      "Die ausgewählte Aktivitäts-Person muss eine gültige Mitglieds-ID sein.",
    );
  }
  return memberId;
}

export function resolveActivityActor(
  db: Db,
  authMember: Member | null,
  actorHeader: string | string[] | undefined,
  allowHeaderFallback: boolean,
): ActivityActor | null {
  if (authMember) {
    return {
      id: authMember.id,
      name: authMember.name,
      color: authMember.color,
    };
  }
  if (!allowHeaderFallback || actorHeader === undefined) return null;

  const memberId = parseActorMemberId(actorHeader);
  const member = db
    .select()
    .from(schema.members)
    .where(eq(schema.members.id, memberId))
    .get();
  if (!member) {
    throw AppError.badRequest(
      "Die ausgewählte Aktivitäts-Person existiert nicht.",
    );
  }
  return member;
}

export function registerActivityActorResolution(
  app: FastifyInstance,
  db: Db,
  env: Env,
): void {
  app.decorateRequest("activityActor", null);
  app.addHook("onRequest", async (request) => {
    request.activityActor = resolveActivityActor(
      db,
      request.authMember,
      request.headers[ACTIVITY_ACTOR_HEADER],
      env.oidc === null,
    );
  });
}

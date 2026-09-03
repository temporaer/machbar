import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  ContextAvailability,
  HomeAssistantContextSnapshot,
  HomeAssistantIntegrationStatus,
  HomeAssistantPairingCode,
  HomeAssistantPairingResponse,
  PhysicalContext,
} from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { Graph } from "../domain/graph.js";
import { AppError } from "../errors.js";
import { enqueueNotification } from "../notifications/outbox.js";

export const HOME_ASSISTANT_PROTOCOL_VERSION = 1 as const;
export const HOME_ASSISTANT_STALE_MS = 30 * 60 * 1_000;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function nowIso(): string {
  return new Date().toISOString();
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function pairingCode(): string {
  const characters = Array.from(
    { length: 8 },
    () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)],
  ).join("");
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
}

function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

function assertProtocolVersion(version: number): asserts version is 1 {
  if (version !== HOME_ASSISTANT_PROTOCOL_VERSION) {
    throw AppError.badRequest(
      "unsupported_protocol_version",
      "The Home Assistant protocol version is not supported.",
      {
        received: version,
        supported: HOME_ASSISTANT_PROTOCOL_VERSION,
      },
    );
  }
}

export function createHomeAssistantPairingCode(
  db: Db,
  createdByMemberId: number | null,
): HomeAssistantPairingCode {
  const code = pairingCode();
  const createdAt = Date.now();
  const expiresAt = new Date(createdAt + PAIRING_TTL_MS).toISOString();
  db.insert(schema.homeAssistantPairingCodes)
    .values({
      codeHash: hashSecret(normalizePairingCode(code)),
      expiresAt,
      createdByMemberId,
      createdAt: new Date(createdAt).toISOString(),
    })
    .run();
  return { code, expiresAt };
}

export function pairHomeAssistant(
  db: Db,
  code: string,
  protocolVersion: number,
): HomeAssistantPairingResponse {
  assertProtocolVersion(protocolVersion);
  const suppliedHash = hashSecret(normalizePairingCode(code));
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(schema.homeAssistantPairingCodes)
      .all()
      .find((candidate) => equalHash(candidate.codeHash, suppliedHash));
    if (!row) {
      throw AppError.unauthorized(
        "pairing_code_invalid",
        "The Home Assistant pairing code is invalid.",
      );
    }
    if (row.consumedAt !== null) {
      throw AppError.unauthorized(
        "pairing_code_used",
        "The Home Assistant pairing code has already been used.",
      );
    }
    const now = nowIso();
    if (row.expiresAt <= now) {
      throw AppError.unauthorized(
        "pairing_code_expired",
        "The Home Assistant pairing code has expired.",
      );
    }

    const token = `mbha_${randomBytes(32).toString("base64url")}`;
    const instanceId = randomBytes(16).toString("hex");
    tx.update(schema.homeAssistantPairingCodes)
      .set({ consumedAt: now })
      .where(eq(schema.homeAssistantPairingCodes.codeHash, row.codeHash))
      .run();
    tx.update(schema.homeAssistantIntegrations)
      .set({ revokedAt: now })
      .where(isNull(schema.homeAssistantIntegrations.revokedAt))
      .run();
    tx.insert(schema.homeAssistantIntegrations)
      .values({
        instanceId,
        tokenHash: hashSecret(token),
        protocolVersion: HOME_ASSISTANT_PROTOCOL_VERSION,
        connectedAt: now,
      })
      .run();
    return {
      token,
      instanceId,
      protocolVersion: HOME_ASSISTANT_PROTOCOL_VERSION,
    };
  });
}

export function authenticateHomeAssistant(
  db: Db,
  authorization: string | undefined,
): typeof schema.homeAssistantIntegrations.$inferSelect {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    throw AppError.unauthorized(
      "integration_authentication_required",
      "A Home Assistant integration token is required.",
    );
  }
  const suppliedHash = hashSecret(authorization.slice(prefix.length));
  const integration = db
    .select()
    .from(schema.homeAssistantIntegrations)
    .where(isNull(schema.homeAssistantIntegrations.revokedAt))
    .all()
    .find((candidate) => equalHash(candidate.tokenHash, suppliedHash));
  if (!integration) {
    throw AppError.unauthorized(
      "integration_token_revoked",
      "The Home Assistant integration token is invalid or revoked.",
    );
  }
  return integration;
}

export function revokeHomeAssistant(db: Db): void {
  db.update(schema.homeAssistantIntegrations)
    .set({ revokedAt: nowIso() })
    .where(isNull(schema.homeAssistantIntegrations.revokedAt))
    .run();
}

export function applyHomeAssistantSnapshot(
  db: Db,
  integrationId: number,
  snapshot: HomeAssistantContextSnapshot,
): void {
  assertProtocolVersion(snapshot.protocolVersion);
  db.transaction((tx) => {
    const integration = tx
      .select()
      .from(schema.homeAssistantIntegrations)
      .where(
        and(
          eq(schema.homeAssistantIntegrations.id, integrationId),
          isNull(schema.homeAssistantIntegrations.revokedAt),
        ),
      )
      .get();
    if (!integration) {
      throw AppError.unauthorized(
        "integration_token_revoked",
        "The Home Assistant integration token has been revoked.",
      );
    }

    tx.update(schema.physicalContexts)
      .set({ active: false, updatedAt: snapshot.observedAt })
      .where(eq(schema.physicalContexts.source, "home_assistant"))
      .run();
    for (const context of snapshot.contexts) {
      tx.insert(schema.physicalContexts)
        .values({
          source: "home_assistant",
          externalId: context.externalId,
          name: context.name,
          active: true,
          updatedAt: snapshot.observedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.physicalContexts.source,
            schema.physicalContexts.externalId,
          ],
          set: {
            name: context.name,
            active: true,
            updatedAt: snapshot.observedAt,
          },
        })
        .run();
    }

    const existingPeople = tx
      .select()
      .from(schema.homeAssistantPeople)
      .where(eq(schema.homeAssistantPeople.integrationId, integrationId))
      .all();
    const existingPersonContexts =
      existingPeople.length === 0
        ? []
        : tx
            .select()
            .from(schema.homeAssistantPersonContexts)
            .where(
              inArray(
                schema.homeAssistantPersonContexts.personId,
                existingPeople.map((person) => person.id),
              ),
            )
            .all();
    const previousContextIdsByPerson = new Map(
      existingPeople.map((person) => [
        person.externalId,
        new Set(
          existingPersonContexts
            .filter((row) => row.personId === person.id)
            .map((row) => row.contextId),
        ),
      ]),
    );
    if (existingPeople.length > 0) {
      tx.delete(schema.homeAssistantPersonContexts)
        .where(
          inArray(
            schema.homeAssistantPersonContexts.personId,
            existingPeople.map((person) => person.id),
          ),
        )
        .run();
      for (const person of existingPeople) {
        tx.update(schema.homeAssistantPeople)
          .set({ state: "unknown", observedAt: snapshot.observedAt })
          .where(eq(schema.homeAssistantPeople.id, person.id))
          .run();
      }
    }

    const contextsByExternalId = new Map(
      tx
        .select()
        .from(schema.physicalContexts)
        .where(eq(schema.physicalContexts.source, "home_assistant"))
        .all()
        .map((context) => [context.externalId, context]),
    );
    const enteredContexts: Array<{
      memberId: number;
      context: PhysicalContext;
    }> = [];
    for (const person of snapshot.people) {
      tx.insert(schema.homeAssistantPeople)
        .values({
          integrationId,
          externalId: person.externalId,
          name: person.name,
          state: person.state,
          observedAt: snapshot.observedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.homeAssistantPeople.integrationId,
            schema.homeAssistantPeople.externalId,
          ],
          set: {
            name: person.name,
            state: person.state,
            observedAt: snapshot.observedAt,
          },
        })
        .run();
      const stored = tx
        .select()
        .from(schema.homeAssistantPeople)
        .where(
          and(
            eq(schema.homeAssistantPeople.integrationId, integrationId),
            eq(schema.homeAssistantPeople.externalId, person.externalId),
          ),
        )
        .get()!;
      const mapping = tx
        .select()
        .from(schema.homeAssistantMemberMappings)
        .where(eq(schema.homeAssistantMemberMappings.personId, stored.id))
        .get();
      if (person.state === "known") {
        for (const externalId of new Set(person.contexts)) {
          const context = contextsByExternalId.get(externalId);
          if (context?.active) {
            tx.insert(schema.homeAssistantPersonContexts)
              .values({ personId: stored.id, contextId: context.id })
              .onConflictDoNothing()
              .run();
            const previousContextIds = previousContextIdsByPerson.get(
              person.externalId,
            );
            if (
              previousContextIds !== undefined &&
              !previousContextIds.has(context.id) &&
              context.externalId !== "zone.home" &&
              mapping
            ) {
              enteredContexts.push({
                memberId: mapping.memberId,
                context,
              });
            }
          }
        }
      }
    }
    const txDb = tx as unknown as Db;
    tx.update(schema.homeAssistantIntegrations)
      .set({ lastUpdateAt: nowIso() })
      .where(eq(schema.homeAssistantIntegrations.id, integrationId))
      .run();
    if (enteredContexts.length > 0) {
      const graph = Graph.load(txDb);
      for (const { memberId, context } of enteredContexts) {
        for (const task of graph.tasksById.values()) {
          if (
            task.status !== "actionable" ||
            !task.executable ||
            (task.effectiveOwnerId !== null &&
              task.effectiveOwnerId !== memberId) ||
            !task.effectiveContexts.some((item) => item.id === context.id) ||
            contextAvailabilityForMember(
              txDb,
              task.effectiveContexts,
              memberId,
            ).status !== "available"
          ) {
            continue;
          }
          enqueueNotification(txDb, {
            kind: "context_entered",
            recipientMemberId: memberId,
            actorMemberId: null,
            entityType: "task",
            entityId: task.id,
            entityTitle: `${context.name}: ${task.title}`,
            sourceKey: `context:${context.id}:member:${memberId}:task:${task.id}:entered:${snapshot.observedAt}`,
          });
        }
      }
    }
  });
}

function activeIntegration(db: Db) {
  return db
    .select()
    .from(schema.homeAssistantIntegrations)
    .where(isNull(schema.homeAssistantIntegrations.revokedAt))
    .get();
}

function isFresh(value: string | null, now: Date): boolean {
  return (
    value !== null &&
    now.getTime() - new Date(value).getTime() <= HOME_ASSISTANT_STALE_MS
  );
}

export function homeAssistantStatus(
  db: Db,
  now = new Date(),
): HomeAssistantIntegrationStatus {
  const integration = activeIntegration(db);
  const contexts = db
    .select()
    .from(schema.physicalContexts)
    .where(eq(schema.physicalContexts.source, "home_assistant"))
    .all() as PhysicalContext[];
  if (!integration) {
    return {
      connected: false,
      instanceId: null,
      protocolVersion: null,
      connectedAt: null,
      lastUpdateAt: null,
      stale: false,
      contexts,
      people: [],
    };
  }
  const people = db
    .select()
    .from(schema.homeAssistantPeople)
    .where(eq(schema.homeAssistantPeople.integrationId, integration.id))
    .all();
  const personContexts = db
    .select()
    .from(schema.homeAssistantPersonContexts)
    .all();
  const mappings = db.select().from(schema.homeAssistantMemberMappings).all();
  return {
    connected: true,
    instanceId: integration.instanceId,
    protocolVersion: integration.protocolVersion,
    connectedAt: integration.connectedAt,
    lastUpdateAt: integration.lastUpdateAt,
    stale: !isFresh(integration.lastUpdateAt, now),
    contexts,
    people: people.map((person) => ({
      externalId: person.externalId,
      name: person.name,
      state: person.state,
      contexts: personContexts
        .filter((row) => row.personId === person.id)
        .map((row) => contexts.find((context) => context.id === row.contextId))
        .filter((context): context is PhysicalContext => context !== undefined),
      mappedMemberId:
        mappings.find((mapping) => mapping.personId === person.id)?.memberId ??
        null,
      observedAt: person.observedAt,
    })),
  };
}

export function setHomeAssistantMemberMapping(
  db: Db,
  externalPersonId: string,
  memberId: number | null,
): void {
  const integration = activeIntegration(db);
  if (!integration) {
    throw AppError.notFound(
      "integration_authentication_required",
      "Home Assistant is not connected.",
    );
  }
  const person = db
    .select()
    .from(schema.homeAssistantPeople)
    .where(
      and(
        eq(schema.homeAssistantPeople.integrationId, integration.id),
        eq(schema.homeAssistantPeople.externalId, externalPersonId),
      ),
    )
    .get();
  if (!person) {
    throw AppError.notFound(
      "identifier_invalid",
      "The Home Assistant person was not found.",
      { externalPersonId },
    );
  }
  db.transaction((tx) => {
    tx.delete(schema.homeAssistantMemberMappings)
      .where(eq(schema.homeAssistantMemberMappings.personId, person.id))
      .run();
    if (memberId !== null) {
      const member = tx
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(eq(schema.members.id, memberId))
        .get();
      if (!member) {
        throw AppError.notFound(
          "member_not_found",
          "The selected member was not found.",
          { memberId },
        );
      }
      tx.delete(schema.homeAssistantMemberMappings)
        .where(eq(schema.homeAssistantMemberMappings.memberId, memberId))
        .run();
      tx.insert(schema.homeAssistantMemberMappings)
        .values({ memberId, personId: person.id })
        .run();
    }
  });
}

export function contextAvailabilityForMember(
  db: Db,
  requiredContexts: PhysicalContext[],
  memberId: number,
  now = new Date(),
): ContextAvailability {
  if (requiredContexts.length === 0) {
    return { status: "available", availableNow: true, missingContexts: [] };
  }
  if (requiredContexts.some((context) => !context.active)) {
    return { status: "unknown", availableNow: true, missingContexts: [] };
  }
  const integration = activeIntegration(db);
  if (!integration || !isFresh(integration.lastUpdateAt, now)) {
    return { status: "unknown", availableNow: true, missingContexts: [] };
  }
  const mapping = db
    .select()
    .from(schema.homeAssistantMemberMappings)
    .where(eq(schema.homeAssistantMemberMappings.memberId, memberId))
    .get();
  if (!mapping) {
    return { status: "unknown", availableNow: true, missingContexts: [] };
  }
  const person = db
    .select()
    .from(schema.homeAssistantPeople)
    .where(eq(schema.homeAssistantPeople.id, mapping.personId))
    .get();
  if (
    !person ||
    person.integrationId !== integration.id ||
    person.state !== "known" ||
    !isFresh(person.observedAt, now)
  ) {
    return { status: "unknown", availableNow: true, missingContexts: [] };
  }
  const present = new Set(
    db
      .select({ contextId: schema.homeAssistantPersonContexts.contextId })
      .from(schema.homeAssistantPersonContexts)
      .where(eq(schema.homeAssistantPersonContexts.personId, person.id))
      .all()
      .map((row) => row.contextId),
  );
  const missingContexts = requiredContexts.filter(
    (context) => !present.has(context.id),
  );
  return missingContexts.length === 0
    ? { status: "available", availableNow: true, missingContexts: [] }
    : { status: "unavailable", availableNow: false, missingContexts };
}

export function contextAvailabilityForHousehold(
  db: Db,
  requiredContexts: PhysicalContext[],
  now = new Date(),
): ContextAvailability {
  const memberIds = db
    .select({ memberId: schema.homeAssistantMemberMappings.memberId })
    .from(schema.homeAssistantMemberMappings)
    .all()
    .map((row) => row.memberId);
  if (memberIds.length === 0) {
    return requiredContexts.length === 0
      ? { status: "available", availableNow: true, missingContexts: [] }
      : { status: "unknown", availableNow: true, missingContexts: [] };
  }
  const results = memberIds.map((memberId) =>
    contextAvailabilityForMember(db, requiredContexts, memberId, now),
  );
  if (results.some((result) => result.status === "available")) {
    return { status: "available", availableNow: true, missingContexts: [] };
  }
  if (results.some((result) => result.status === "unknown")) {
    return { status: "unknown", availableNow: true, missingContexts: [] };
  }
  return {
    status: "unavailable",
    availableNow: false,
    missingContexts: requiredContexts,
  };
}

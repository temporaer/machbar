import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Member } from "@machbar/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppError } from "../errors.js";

const FLOW_TTL_MS = 10 * 60 * 1000;

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function expiresIso(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function memberResult(
  member: typeof schema.members.$inferSelect,
  managedByOidc: boolean,
  pictureUrl: string | null = null,
): Member {
  return { ...member, pictureUrl, managedByOidc };
}

export interface StoredAuthFlow {
  nonce: string;
  pkceVerifier: string;
  returnTo: string;
}

export function storeAuthFlow(
  db: Db,
  input: StoredAuthFlow & { state: string },
  now = new Date(),
): void {
  const current = nowIso(now);
  db.delete(schema.oidcAuthFlows)
    .where(lt(schema.oidcAuthFlows.expiresAt, current))
    .run();
  db.insert(schema.oidcAuthFlows)
    .values({
      stateHash: hashSecret(input.state),
      nonce: input.nonce,
      pkceVerifier: input.pkceVerifier,
      returnTo: input.returnTo,
      expiresAt: expiresIso(now, FLOW_TTL_MS),
    })
    .run();
}

export function consumeAuthFlow(
  db: Db,
  state: string,
  now = new Date(),
): StoredAuthFlow | null {
  return db.transaction((tx) => {
    const stateHash = hashSecret(state);
    const flow = tx
      .select()
      .from(schema.oidcAuthFlows)
      .where(eq(schema.oidcAuthFlows.stateHash, stateHash))
      .get();
    if (!flow) return null;
    tx.delete(schema.oidcAuthFlows)
      .where(eq(schema.oidcAuthFlows.stateHash, stateHash))
      .run();
    if (flow.expiresAt <= nowIso(now)) return null;
    return {
      nonce: flow.nonce,
      pkceVerifier: flow.pkceVerifier,
      returnTo: flow.returnTo,
    };
  });
}

export interface OidcIdentityClaims {
  issuer: string;
  subject: string;
  name: string;
  email?: string;
  preferredUsername?: string;
  pictureUrl?: string;
}

export function resolveOidcMember(db: Db, claims: OidcIdentityClaims): Member {
  const name = claims.name.trim();
  if (!name) {
    throw AppError.badRequest(
      "Pocket ID hat keinen verwendbaren Namen für dieses Konto geliefert.",
    );
  }

  return db.transaction((tx) => {
    const identity = tx
      .select()
      .from(schema.memberOidcIdentities)
      .where(
        and(
          eq(schema.memberOidcIdentities.issuer, claims.issuer),
          eq(schema.memberOidcIdentities.subject, claims.subject),
        ),
      )
      .get();

    if (identity) {
      const member = tx
        .select()
        .from(schema.members)
        .where(eq(schema.members.id, identity.memberId))
        .get();
      if (!member) {
        throw AppError.conflict(
          "Die Pocket-ID-Verknüpfung verweist auf kein vorhandenes Mitglied.",
        );
      }
      if (member.name !== name) {
        const collision = tx
          .select()
          .from(schema.members)
          .where(eq(schema.members.name, name))
          .get();
        if (collision && collision.id !== member.id) {
          throw AppError.conflict(
            `Der Pocket-ID-Name "${name}" wird bereits von einem anderen Mitglied verwendet.`,
          );
        }
        tx.update(schema.members)
          .set({ name })
          .where(eq(schema.members.id, member.id))
          .run();
      }
      tx.update(schema.memberOidcIdentities)
        .set({
          email: claims.email ?? null,
          preferredUsername: claims.preferredUsername ?? null,
          pictureUrl: claims.pictureUrl ?? null,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(schema.memberOidcIdentities.issuer, claims.issuer),
            eq(schema.memberOidcIdentities.subject, claims.subject),
          ),
        )
        .run();
      return memberResult({ ...member, name }, true, claims.pictureUrl ?? null);
    }

    let member = tx
      .select()
      .from(schema.members)
      .where(eq(schema.members.name, name))
      .get();

    const preferredUsername = claims.preferredUsername?.trim();
    if (!member && preferredUsername) {
      const normalizedUsername = preferredUsername.toLocaleLowerCase("de-DE");
      const usernameMatches = tx
        .select()
        .from(schema.members)
        .all()
        .filter(
          (candidate) =>
            candidate.name.toLocaleLowerCase("de-DE") === normalizedUsername,
        );
      if (usernameMatches.length > 1) {
        throw AppError.conflict(
          `Der Pocket-ID-Benutzername "${preferredUsername}" passt zu mehreren Mitgliedern.`,
        );
      }
      member = usernameMatches[0];
    }

    if (member) {
      const existingLink = tx
        .select()
        .from(schema.memberOidcIdentities)
        .where(eq(schema.memberOidcIdentities.memberId, member.id))
        .get();
      if (existingLink) {
        throw AppError.conflict(
          `Das Mitglied "${name}" ist bereits mit einem anderen Pocket-ID-Konto verknüpft.`,
        );
      }
      if (member.name !== name) {
        const displayNameCollision = tx
          .select()
          .from(schema.members)
          .where(eq(schema.members.name, name))
          .get();
        if (displayNameCollision && displayNameCollision.id !== member.id) {
          throw AppError.conflict(
            `Der Pocket-ID-Name "${name}" wird bereits von einem anderen Mitglied verwendet.`,
          );
        }
        tx.update(schema.members)
          .set({ name })
          .where(eq(schema.members.id, member.id))
          .run();
        member = { ...member, name };
      }
    } else {
      member = tx
        .insert(schema.members)
        .values({ name, color: "" })
        .returning()
        .get();
    }

    tx.insert(schema.memberOidcIdentities)
      .values({
        issuer: claims.issuer,
        subject: claims.subject,
        memberId: member.id,
        email: claims.email ?? null,
        preferredUsername: claims.preferredUsername ?? null,
        pictureUrl: claims.pictureUrl ?? null,
      })
      .run();

    return memberResult(member, true, claims.pictureUrl ?? null);
  });
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export function createSession(
  db: Db,
  memberId: number,
  ttlDays: number,
  now = new Date(),
): CreatedSession {
  const token = randomSecret();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  db.delete(schema.authSessions)
    .where(lt(schema.authSessions.expiresAt, nowIso(now)))
    .run();
  db.insert(schema.authSessions)
    .values({
      tokenHash: hashSecret(token),
      memberId,
      expiresAt: expiresAt.toISOString(),
      lastSeenAt: nowIso(now),
    })
    .run();
  return { token, expiresAt };
}

export function getSessionMember(
  db: Db,
  token: string,
  now = new Date(),
): Member | null {
  const tokenHash = hashSecret(token);
  const row = db
    .select({
      session: schema.authSessions,
      member: schema.members,
      identityMemberId: schema.memberOidcIdentities.memberId,
      pictureUrl: schema.memberOidcIdentities.pictureUrl,
    })
    .from(schema.authSessions)
    .innerJoin(
      schema.members,
      eq(schema.authSessions.memberId, schema.members.id),
    )
    .leftJoin(
      schema.memberOidcIdentities,
      eq(schema.members.id, schema.memberOidcIdentities.memberId),
    )
    .where(eq(schema.authSessions.tokenHash, tokenHash))
    .get();
  if (!row) return null;
  if (row.session.expiresAt <= nowIso(now)) {
    db.delete(schema.authSessions)
      .where(eq(schema.authSessions.tokenHash, tokenHash))
      .run();
    return null;
  }
  db.update(schema.authSessions)
    .set({ lastSeenAt: nowIso(now) })
    .where(eq(schema.authSessions.tokenHash, tokenHash))
    .run();
  return memberResult(
    row.member,
    row.identityMemberId !== null,
    row.pictureUrl ?? null,
  );
}

export function deleteSession(db: Db, token: string): void {
  db.delete(schema.authSessions)
    .where(eq(schema.authSessions.tokenHash, hashSecret(token)))
    .run();
}

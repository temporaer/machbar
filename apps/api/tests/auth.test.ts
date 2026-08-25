import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import type {
  AuthorizationRequest,
  OidcProvider,
} from "../src/auth/oidcClient.js";
import type { OidcIdentityClaims } from "../src/auth/repository.js";
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

class FakeOidcProvider implements OidcProvider {
  stateCounter = 0;
  claims: OidcIdentityClaims = {
    issuer: oidc.issuerUrl,
    subject: "subject-hannes",
    name: "Hannes",
    email: "hannes@example.test",
    preferredUsername: "hannes",
  };
  exchanges: Array<{
    callbackUrl: URL;
    checks: { state: string; nonce: string; pkceVerifier: string };
  }> = [];

  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    this.stateCounter += 1;
    const state = `state-${this.stateCounter}`;
    return {
      url: new URL(
        `https://pocket.example/authorize?state=${encodeURIComponent(state)}`,
      ),
      state,
      nonce: `nonce-${this.stateCounter}`,
      pkceVerifier: `verifier-${this.stateCounter}`,
    };
  }

  async exchangeCallback(
    callbackUrl: URL,
    checks: { state: string; nonce: string; pkceVerifier: string },
  ): Promise<OidcIdentityClaims> {
    this.exchanges.push({ callbackUrl, checks });
    return this.claims;
  }
}

function namedCookie(
  setCookie: string | string[] | undefined,
  name: string,
): string {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  const header = headers.find((value) => value?.startsWith(`${name}=`));
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  return namedCookie(setCookie, "__Host-machbar-session");
}

describe("Pocket ID authentication", () => {
  let ctx: TestContext;
  let provider: FakeOidcProvider;

  beforeEach(() => {
    provider = new FakeOidcProvider();
    ctx = createTestContext({ oidc, oidcProvider: provider });
  });

  afterEach(async () => {
    await closeTestContext(ctx);
  });

  async function login(returnTo = "/#/heute") {
    const start = await ctx.app.inject({
      method: "GET",
      url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get("state");
    expect(state).toBeTruthy();
    return ctx.app.inject({
      method: "GET",
      url: `/api/auth/callback?code=test-code&state=${encodeURIComponent(state!)}`,
      headers: {
        cookie: namedCookie(
          start.headers["set-cookie"],
          "__Host-machbar-oidc-state",
        ),
      },
    });
  }

  it("keeps health and auth status public but protects ordinary API routes", async () => {
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/health" })).statusCode,
    ).toBe(200);
    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: true,
      authenticated: false,
      member: null,
    });

    const members = await ctx.app.inject({
      method: "GET",
      url: "/api/members",
    });
    expect(members.statusCode).toBe(401);
    expect(members.json().error.message).toMatch(/Pocket ID/);
  });

  it("links an exact existing member, sets a hardened cookie, and restores the hash route", async () => {
    const existing = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Hannes", color: "#123456" })
      .returning()
      .get();

    const callback = await login("/#/projekte");
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://machbar.example/#/projekte",
    );
    const setCookie = callback.headers["set-cookie"];
    const sessionHeader = Array.isArray(setCookie)
      ? setCookie.find((value) =>
          value.startsWith("__Host-machbar-session="),
        )
      : setCookie;
    expect(sessionHeader).toContain("__Host-machbar-session=");
    expect(sessionHeader).toContain("Secure");
    expect(sessionHeader).toContain("HttpOnly");
    expect(sessionHeader).toContain("SameSite=Lax");
    expect(sessionHeader).toContain("Path=/");

    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: sessionCookie(setCookie) },
    });
    expect(status.json()).toMatchObject({
      enabled: true,
      authenticated: true,
      member: {
        id: existing.id,
        name: "Hannes",
        color: "#123456",
        managedByOidc: true,
      },
    });
    expect(provider.exchanges[0]?.checks).toEqual({
      state: "state-1",
      nonce: "nonce-1",
      pkceVerifier: "verifier-1",
    });
  });

  it("auto-provisions once by subject and synchronizes the Pocket ID name", async () => {
    const first = await login();
    const cookie = sessionCookie(first.headers["set-cookie"]);
    const firstStatus = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie },
    });
    const memberId = firstStatus.json().member.id;

    provider.claims = { ...provider.claims, name: "Hannes R." };
    const second = await login();
    const secondStatus = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: sessionCookie(second.headers["set-cookie"]) },
    });
    expect(secondStatus.json().member).toMatchObject({
      id: memberId,
      name: "Hannes R.",
      managedByOidc: true,
    });
    expect(
      ctx.handle.db.select().from(schema.members).all(),
    ).toHaveLength(1);
  });

  it("never lets a second Pocket ID subject claim an already-linked name", async () => {
    expect((await login()).statusCode).toBe(302);
    provider.claims = {
      ...provider.claims,
      subject: "different-subject",
    };

    const conflicting = await login();
    expect(conflicting.statusCode).toBe(302);
    expect(conflicting.headers.location).toContain("authError=");
    expect(
      ctx.handle.db.select().from(schema.memberOidcIdentities).all(),
    ).toHaveLength(1);
    expect(
      ctx.handle.db.select().from(schema.members).all(),
    ).toHaveLength(1);
  });

  it("consumes callback state once and rejects unsafe return targets", async () => {
    const start = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/login",
    });
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const callbackUrl = `/api/auth/callback?code=test&state=${state}`;
    const correlationCookie = namedCookie(
      start.headers["set-cookie"],
      "__Host-machbar-oidc-state",
    );
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: callbackUrl,
          headers: { cookie: correlationCookie },
        })
      ).statusCode,
    ).toBe(302);
    const replay = await ctx.app.inject({
      method: "GET",
      url: callbackUrl,
      headers: { cookie: correlationCookie },
    });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location).toContain("authError=");

    const external = await ctx.app.inject({
      method: "GET",
      url: `/api/auth/login?returnTo=${encodeURIComponent("https://evil.example/")}`,
    });
    expect(external.statusCode).toBe(400);
  });

  it("rejects a valid provider callback in a browser that did not start the login", async () => {
    const start = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/login",
    });
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const swapped = await ctx.app.inject({
      method: "GET",
      url: `/api/auth/callback?code=test&state=${state}`,
    });

    expect(swapped.statusCode).toBe(302);
    expect(swapped.headers.location).toContain("authError=");
    expect(swapped.headers["set-cookie"]).not.toContain(
      "__Host-machbar-session=",
    );
    expect(provider.exchanges).toHaveLength(0);
  });

  it("binds creator and Heute identity to the session instead of caller input", async () => {
    const other = ctx.handle.db
      .insert(schema.members)
      .values({ name: "Other", color: "" })
      .returning()
      .get();
    const callback = await login();
    const cookie = sessionCookie(callback.headers["set-cookie"]);
    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie },
    });
    const currentId = status.json().member.id;

    const task = await ctx.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        cookie,
        origin: oidc.publicUrl,
        "content-type": "application/json",
      },
      payload: {
        title: "Sessiongebundene Aufgabe",
        status: "actionable",
        ownerMemberId: currentId,
        ownerInheritanceMode: "explicit",
        createdByMemberId: other.id,
      },
    });
    expect(task.statusCode).toBe(201);
    expect(task.json().createdByMemberId).toBe(currentId);

    const agenda = await ctx.app.inject({
      method: "GET",
      url: `/api/agenda/today?memberId=${other.id}`,
      headers: { cookie },
    });
    expect(
      agenda.json().unscheduled.map((item: { title: string }) => item.title),
    ).toContain("Sessiongebundene Aufgabe");
  });

  it("rejects cross-origin writes and invalidates the local session on logout", async () => {
    const callback = await login();
    const cookie = sessionCookie(callback.headers["set-cookie"]);

    const wrongOrigin = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: oidc.publicUrl },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain(
      "__Host-machbar-session=;",
    );

    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie },
    });
    expect(status.json().authenticated).toBe(false);
  });

  it("marks linked members as provider-managed and blocks local rename/delete", async () => {
    const callback = await login();
    const cookie = sessionCookie(callback.headers["set-cookie"]);
    const members = await ctx.app.inject({
      method: "GET",
      url: "/api/members",
      headers: { cookie },
    });
    expect(members.json()[0]).toMatchObject({
      name: "Hannes",
      managedByOidc: true,
    });
    const memberId = members.json()[0].id;

    const rename = await ctx.app.inject({
      method: "PATCH",
      url: `/api/members/${memberId}`,
      headers: {
        cookie,
        origin: oidc.publicUrl,
        "content-type": "application/json",
      },
      payload: { name: "Anders" },
    });
    expect(rename.statusCode).toBe(409);

    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/members/${memberId}`,
      headers: { cookie, origin: oidc.publicUrl },
    });
    expect(remove.statusCode).toBe(409);
  });
});

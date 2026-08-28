import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("OIDC environment configuration", () => {
  it("keeps authentication disabled outside production when no OIDC variables are present", () => {
    expect(loadEnv({}).oidc).toBeNull();
  });

  it("requires OIDC configuration in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(
      /required in production/i,
    );
  });

  it("rejects partial OIDC configuration instead of silently disabling auth", () => {
    expect(() =>
      loadEnv({ OIDC_ISSUER_URL: "https://pocket.example" }),
    ).toThrow(/incomplete/i);
  });

  it("loads a complete HTTPS configuration with the household session default", () => {
    expect(
      loadEnv({
        OIDC_ISSUER_URL: "https://pocket.example/",
        OIDC_CLIENT_ID: "machbar",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_PUBLIC_URL: "https://machbar.example",
      }).oidc,
    ).toEqual({
      issuerUrl: "https://pocket.example",
      clientId: "machbar",
      clientSecret: "secret",
      publicUrl: "https://machbar.example",
      sessionTtlDays: 30,
    });
  });

  it("rejects insecure URLs, public URL paths, and unreasonable session limits", () => {
    const valid = {
      OIDC_ISSUER_URL: "https://pocket.example",
      OIDC_CLIENT_ID: "machbar",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_PUBLIC_URL: "https://machbar.example",
    };
    expect(() =>
      loadEnv({ ...valid, OIDC_ISSUER_URL: "http://pocket.example" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      loadEnv({ ...valid, OIDC_PUBLIC_URL: "https://machbar.example/tasks" }),
    ).toThrow(/path/i);
    expect(() =>
      loadEnv({ ...valid, OIDC_SESSION_TTL_DAYS: "0" }),
    ).toThrow(/between 1 and 365/);
  });
});

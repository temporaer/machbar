import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("OIDC environment configuration", () => {
  it("keeps authentication disabled outside production when no OIDC variables are present", () => {
    expect(loadEnv({}).oidc).toBeNull();
  });

  describe("VAPID environment configuration", () => {
    const unauthenticated = { ALLOW_UNAUTHENTICATED: "true" };

    it("keeps Push disabled when no VAPID variables are present", () => {
      expect(loadEnv(unauthenticated).push).toBeNull();
    });

    it("rejects partial VAPID configuration", () => {
      expect(() =>
        loadEnv({
          ...unauthenticated,
          VAPID_PUBLIC_KEY: "public",
        }),
      ).toThrow(/VAPID configuration is incomplete/);
    });

    it("loads complete VAPID configuration", () => {
      expect(
        loadEnv({
          ...unauthenticated,
          VAPID_PUBLIC_KEY: "public",
          VAPID_PRIVATE_KEY: "private",
          VAPID_SUBJECT: "https://machbar.example",
        }).push,
      ).toEqual({
        publicKey: "public",
        privateKey: "private",
        subject: "https://machbar.example",
      });
    });

    it("rejects an insecure non-mailto subject", () => {
      expect(() =>
        loadEnv({
          ...unauthenticated,
          VAPID_PUBLIC_KEY: "public",
          VAPID_PRIVATE_KEY: "private",
          VAPID_SUBJECT: "http://machbar.example",
        }),
      ).toThrow(/HTTPS/);
    });
  });

  it("requires OIDC configuration in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(
      /required in production/i,
    );
  });

  it("allows an explicit unauthenticated production deployment", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        ALLOW_UNAUTHENTICATED: "true",
      }).oidc,
    ).toBeNull();
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        ALLOW_UNAUTHENTICATED: "TRUE",
      }),
    ).toThrow(/required in production/i);
  });

  it("rejects partial OIDC configuration instead of silently disabling auth", () => {
    expect(() =>
      loadEnv({
        ALLOW_UNAUTHENTICATED: "true",
        OIDC_ISSUER_URL: "https://pocket.example",
      }),
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

  describe("Paperless environment configuration", () => {
    const unauthenticated = { ALLOW_UNAUTHENTICATED: "true" };

    it("keeps Paperless disabled when neither variable is present", () => {
      expect(loadEnv(unauthenticated).paperless).toBeNull();
    });

    it("rejects partial Paperless configuration (URL only)", () => {
      expect(() =>
        loadEnv({
          ...unauthenticated,
          PAPERLESS_URL: "https://paperless.example",
        }),
      ).toThrow(/Paperless configuration is incomplete/);
    });

    it("rejects partial Paperless configuration (token only)", () => {
      expect(() =>
        loadEnv({
          ...unauthenticated,
          PAPERLESS_API_TOKEN: "secret-token",
        }),
      ).toThrow(/Paperless configuration is incomplete/);
    });

    it("loads a complete Paperless configuration and normalizes the HTTPS URL", () => {
      expect(
        loadEnv({
          ...unauthenticated,
          PAPERLESS_URL: "https://paperless.example/",
          PAPERLESS_API_TOKEN: "secret-token",
        }).paperless,
      ).toEqual({
        baseUrl: "https://paperless.example",
        apiToken: "secret-token",
      });
    });

    it("rejects an insecure non-HTTPS Paperless URL", () => {
      expect(() =>
        loadEnv({
          ...unauthenticated,
          PAPERLESS_URL: "http://paperless.example",
          PAPERLESS_API_TOKEN: "secret-token",
        }),
      ).toThrow(/HTTPS/);
    });
  });
});

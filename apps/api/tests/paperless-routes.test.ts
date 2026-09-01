import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthorizationRequest,
  OidcProvider,
} from "../src/auth/oidcClient.js";
import type { OidcIdentityClaims } from "../src/auth/repository.js";
import type { OidcConfig, PaperlessConfig } from "../src/env.js";
import type {
  PaperlessBinary,
  PaperlessClient,
  PaperlessSearchResult,
  PaperlessUploadResult,
} from "../src/paperless/client.js";
import type { PaperlessDocumentSummary } from "@machbar/shared";
import { AppError } from "../src/errors.js";
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

const paperlessConfig: PaperlessConfig = {
  baseUrl: "https://paperless.example",
  apiToken: "test-token",
};

class FakeOidcProvider implements OidcProvider {
  stateCounter = 0;
  claims: OidcIdentityClaims = {
    issuer: oidc.issuerUrl,
    subject: "subject-hannes",
    name: "Hannes",
    email: "hannes@example.test",
    preferredUsername: "hannes",
    pictureUrl: undefined,
  };

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

  async exchangeCallback(): Promise<OidcIdentityClaims> {
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

/** Default no-op implementations; tests override only what they exercise. */
function fakePaperlessClient(
  overrides: Partial<PaperlessClient> = {},
): PaperlessClient {
  return {
    upload: vi.fn(async (): Promise<PaperlessUploadResult> => {
      throw new Error("upload not stubbed");
    }),
    awaitDocumentId: vi.fn(async (): Promise<number> => {
      throw new Error("awaitDocumentId not stubbed");
    }),
    getDocument: vi.fn(async (): Promise<PaperlessDocumentSummary> => {
      throw new Error("getDocument not stubbed");
    }),
    search: vi.fn(async (): Promise<PaperlessSearchResult> => {
      throw new Error("search not stubbed");
    }),
    thumbnail: vi.fn(async (): Promise<PaperlessBinary> => {
      throw new Error("thumbnail not stubbed");
    }),
    preview: vi.fn(async (): Promise<PaperlessBinary> => {
      throw new Error("preview not stubbed");
    }),
    download: vi.fn(async (): Promise<PaperlessBinary> => {
      throw new Error("download not stubbed");
    }),
    ...overrides,
  };
}

function binaryOf(
  bytes: Buffer,
  extra: Partial<PaperlessBinary> = {},
): PaperlessBinary {
  return {
    contentType: "application/octet-stream",
    contentLength: bytes.length,
    filename: null,
    body: Readable.from([bytes]),
    ...extra,
  };
}

/** Builds a minimal multipart/form-data body carrying one file field. */
function multipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  data: Buffer,
): { boundary: string; body: Buffer } {
  const boundary = "----machbarTestBoundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

const BASE = "/api/integrations/paperless/documents";

describe("Paperless integration routes", () => {
  describe("when Paperless is not configured", () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(async () => {
      await closeTestContext(ctx);
    });

    it("returns a stable paperless_not_configured error from every route", async () => {
      const { boundary, body } = multipartBody(
        "document",
        "receipt.pdf",
        "application/pdf",
        Buffer.from("pdf-bytes"),
      );
      const responses = await Promise.all([
        ctx.app.inject({
          method: "POST",
          url: BASE,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: body,
        }),
        ctx.app.inject({ method: "GET", url: `${BASE}?query=receipt` }),
        ctx.app.inject({ method: "GET", url: `${BASE}/1/thumbnail` }),
        ctx.app.inject({ method: "GET", url: `${BASE}/1/preview` }),
        ctx.app.inject({ method: "GET", url: `${BASE}/1/download` }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("paperless_not_configured");
      }
    });
  });

  describe("when Paperless is configured", () => {
    let ctx: TestContext;
    let client: PaperlessClient;

    beforeEach(() => {
      client = fakePaperlessClient();
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });
    });

    afterEach(async () => {
      await closeTestContext(ctx);
    });

    it("rejects an invalid document ID before contacting Paperless", async () => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}/not-a-number/thumbnail`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("identifier_invalid");
      expect(client.thumbnail).not.toHaveBeenCalled();
    });

    it("requires a search query", async () => {
      const response = await ctx.app.inject({
        method: "GET",
        url: BASE,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("paperless_query_invalid");
      expect(client.search).not.toHaveBeenCalled();
    });

    it("uploads a file, waits for the document ID, and returns its summary", async () => {
      const upload = vi.fn(
        async (): Promise<PaperlessUploadResult> => ({ taskId: "task-1" }),
      );
      const awaitDocumentId = vi.fn(async (): Promise<number> => 55);
      const summary: PaperlessDocumentSummary = {
        id: 55,
        title: "Grocery receipt",
        originalFileName: "receipt.pdf",
        mimeType: "application/pdf",
      };
      const getDocument = vi.fn(async () => summary);
      client = fakePaperlessClient({ upload, awaitDocumentId, getDocument });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const { boundary, body } = multipartBody(
        "document",
        "receipt.pdf",
        "application/pdf",
        Buffer.from("pdf-bytes"),
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: BASE,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(summary);
      expect(upload).toHaveBeenCalledWith({
        filename: "receipt.pdf",
        contentType: "application/pdf",
        data: Buffer.from("pdf-bytes"),
      });
      expect(awaitDocumentId).toHaveBeenCalledWith("task-1");
      expect(getDocument).toHaveBeenCalledWith(55);
    });

    it("rejects uploads larger than the 25MB cap without contacting Paperless", async () => {
      const upload = vi.fn();
      client = fakePaperlessClient({ upload: upload as never });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const oversized = Buffer.alloc(25 * 1024 * 1024 + 1024, 1);
      const { boundary, body } = multipartBody(
        "document",
        "huge.pdf",
        "application/pdf",
        oversized,
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: BASE,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("paperless_file_too_large");
      expect(upload).not.toHaveBeenCalled();
    });

    it("searches and returns Paperless results as a document summary array", async () => {
      const searchResult: PaperlessSearchResult = {
        count: 1,
        results: [
          {
            id: 3,
            title: "Grocery receipt",
            originalFileName: "receipt.pdf",
            mimeType: "application/pdf",
          },
        ],
      };
      const search = vi.fn(async () => searchResult);
      client = fakePaperlessClient({ search });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}?query=receipt&page=2&pageSize=10`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(searchResult.results);
      expect(search).toHaveBeenCalledWith("receipt", { page: 2, pageSize: 10 });
    });

    it("streams a thumbnail with its content type, length, and bytes", async () => {
      const bytes = Buffer.from([1, 2, 3, 4]);
      const thumbnail = vi.fn(async () =>
        binaryOf(bytes, { contentType: "image/webp" }),
      );
      client = fakePaperlessClient({ thumbnail });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}/42/thumbnail`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/webp");
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      expect(response.rawPayload).toEqual(bytes);
      expect(thumbnail).toHaveBeenCalledWith(42);
    });

    it("sends the download as an attachment with the upstream filename", async () => {
      const bytes = Buffer.from("file-bytes");
      const download = vi.fn(async () =>
        binaryOf(bytes, {
          contentType: "application/pdf",
          filename: "Grocery Receipt.pdf",
        }),
      );
      client = fakePaperlessClient({ download });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}/7/download`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="Grocery Receipt.pdf"',
      );
      expect(response.rawPayload).toEqual(bytes);
    });

    it("sends the preview inline", async () => {
      const bytes = Buffer.from("preview-bytes");
      const preview = vi.fn(async () =>
        binaryOf(bytes, { contentType: "application/pdf", filename: null }),
      );
      client = fakePaperlessClient({ preview });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}/7/preview`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toBe("inline");
    });

    it("maps client errors to their declared status codes", async () => {
      const thumbnail = vi.fn(async () => {
        throw AppError.notFound(
          "paperless_document_not_found",
          "The Paperless document was not found.",
        );
      });
      client = fakePaperlessClient({ thumbnail });
      ctx = createTestContext({ paperless: paperlessConfig, paperlessClient: client });

      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}/9/thumbnail`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("paperless_document_not_found");
    });
  });

  describe("authentication and Origin protection", () => {
    let ctx: TestContext;
    let provider: FakeOidcProvider;
    let client: PaperlessClient;

    beforeEach(() => {
      provider = new FakeOidcProvider();
      client = fakePaperlessClient({
        search: vi.fn(async () => ({ count: 0, results: [] })),
        upload: vi.fn(async () => ({ taskId: "task-1" })),
        awaitDocumentId: vi.fn(async () => 1),
        getDocument: vi.fn(async () => ({
          id: 1,
          title: "Grocery receipt",
          originalFileName: "receipt.pdf",
          mimeType: "application/pdf",
        })),
      });
      ctx = createTestContext({
        oidc,
        oidcProvider: provider,
        paperless: paperlessConfig,
        paperlessClient: client,
      });
    });

    afterEach(async () => {
      await closeTestContext(ctx);
    });

    async function login() {
      const start = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/login",
      });
      const state = new URL(start.headers.location!).searchParams.get("state");
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

    it("requires authentication", async () => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}?query=receipt`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("authentication_required");
    });

    it("allows an authenticated GET without an Origin header", async () => {
      const callback = await login();
      const response = await ctx.app.inject({
        method: "GET",
        url: `${BASE}?query=receipt`,
        headers: { cookie: sessionCookie(callback.headers["set-cookie"]) },
      });
      expect(response.statusCode).toBe(200);
    });

    it("rejects an unsafe request from the wrong Origin", async () => {
      const callback = await login();
      const { boundary, body } = multipartBody(
        "document",
        "receipt.pdf",
        "application/pdf",
        Buffer.from("pdf-bytes"),
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: BASE,
        headers: {
          cookie: sessionCookie(callback.headers["set-cookie"]),
          origin: "https://evil.example",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("request_origin_forbidden");
    });

    it("accepts an unsafe request from the configured Origin", async () => {
      const callback = await login();
      const { boundary, body } = multipartBody(
        "document",
        "receipt.pdf",
        "application/pdf",
        Buffer.from("pdf-bytes"),
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: BASE,
        headers: {
          cookie: sessionCookie(callback.headers["set-cookie"]),
          origin: oidc.publicUrl,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
    });
  });
});

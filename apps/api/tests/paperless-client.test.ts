import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { PaperlessConfig } from "../src/env.js";
import { createPaperlessClient } from "../src/paperless/client.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.example",
  apiToken: "test-token",
};

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Builds a fetch mock that replies based on the request path, so each test
 * only needs to describe how the fake Paperless server should respond. */
function fakeFetch(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: Request) => handler(input)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PaperlessClient", () => {
  describe("upload", () => {
    it("returns the task ID Paperless assigns to the upload", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch((request) => {
          expect(request.headers.get("authorization")).toBe(
            "Token test-token",
          );
          expect(request.url).toContain("/api/documents/post_document/");
          return jsonResponse(200, "11111111-1111-1111-1111-111111111111");
        }),
      });
      const result = await client.upload({
        filename: "receipt.pdf",
        contentType: "application/pdf",
        data: Buffer.from("pdf-bytes"),
      });
      expect(result).toEqual({
        taskId: "11111111-1111-1111-1111-111111111111",
      });
    });

    it("maps a 401 to paperless_authentication_failed", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => jsonResponse(401, { detail: "bad token" })),
      });
      await expect(
        client.upload({
          filename: "a.pdf",
          contentType: "application/pdf",
          data: Buffer.from("x"),
        }),
      ).rejects.toMatchObject({ code: "paperless_authentication_failed" });
    });

    it("maps a 400 to paperless_upload_rejected", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          jsonResponse(400, { document: ["Unsupported file type."] }),
        ),
      });
      await expect(
        client.upload({
          filename: "a.exe",
          contentType: "application/x-msdownload",
          data: Buffer.from("x"),
        }),
      ).rejects.toMatchObject({ code: "paperless_upload_rejected" });
    });

    it("maps a 5xx response to paperless_unavailable", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => new Response("boom", { status: 502 })),
      });
      await expect(
        client.upload({
          filename: "a.pdf",
          contentType: "application/pdf",
          data: Buffer.from("x"),
        }),
      ).rejects.toMatchObject({ code: "paperless_unavailable" });
    });

    it("maps a network failure to paperless_unavailable", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => {
          throw new Error("ECONNREFUSED");
        }),
      });
      await expect(
        client.upload({
          filename: "a.pdf",
          contentType: "application/pdf",
          data: Buffer.from("x"),
        }),
      ).rejects.toMatchObject({ code: "paperless_unavailable" });
    });

    it("maps a non-string success body to paperless_response_invalid", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => jsonResponse(200, { unexpected: true })),
      });
      await expect(
        client.upload({
          filename: "a.pdf",
          contentType: "application/pdf",
          data: Buffer.from("x"),
        }),
      ).rejects.toMatchObject({ code: "paperless_response_invalid" });
    });
  });

  describe("awaitDocumentId", () => {
    it("polls until the task succeeds and returns the document ID", async () => {
      let calls = 0;
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => {
          calls += 1;
          if (calls < 3) {
            return jsonResponse(200, { count: 0, results: [] });
          }
          return jsonResponse(200, {
            count: 1,
            results: [
              {
                id: 1,
                task_id: "task-1",
                task_type: "file",
                task_type_display: "File",
                trigger_source: "consume_folder",
                trigger_source_display: "Consume folder",
                status: "success",
                status_display: "Success",
                date_created: "2024-01-01T00:00:00Z",
                acknowledged: false,
                related_document_ids: [42],
              },
            ],
          });
        }),
        sleep: async () => {},
      });
      const documentId = await client.awaitDocumentId("task-1");
      expect(documentId).toBe(42);
      expect(calls).toBe(3);
    });

    it("throws paperless_upload_rejected when the task fails", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          jsonResponse(200, {
            count: 1,
            results: [
              {
                id: 1,
                task_id: "task-1",
                task_type: "file",
                task_type_display: "File",
                trigger_source: "consume_folder",
                trigger_source_display: "Consume folder",
                status: "failure",
                status_display: "Failure",
                date_created: "2024-01-01T00:00:00Z",
                acknowledged: false,
                related_document_ids: [],
                result_data: { message: "duplicate document" },
              },
            ],
          }),
        ),
        sleep: async () => {},
      });
      await expect(client.awaitDocumentId("task-1")).rejects.toMatchObject({
        code: "paperless_upload_rejected",
      });
    });

    it("throws paperless_response_invalid when success has no document ID", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          jsonResponse(200, {
            count: 1,
            results: [
              {
                id: 1,
                task_id: "task-1",
                task_type: "file",
                task_type_display: "File",
                trigger_source: "consume_folder",
                trigger_source_display: "Consume folder",
                status: "success",
                status_display: "Success",
                date_created: "2024-01-01T00:00:00Z",
                acknowledged: false,
                related_document_ids: [],
              },
            ],
          }),
        ),
        sleep: async () => {},
      });
      await expect(client.awaitDocumentId("task-1")).rejects.toMatchObject({
        code: "paperless_response_invalid",
      });
    });

    it("throws paperless_processing_timeout once the deadline passes", async () => {
      let time = 0;
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => jsonResponse(200, { count: 0, results: [] })),
        sleep: async () => {
          time += 1000;
        },
        now: () => time,
      });
      await expect(
        client.awaitDocumentId("task-1", { timeoutMs: 2000, intervalMs: 500 }),
      ).rejects.toMatchObject({ code: "paperless_processing_timeout" });
    });
  });

  describe("search", () => {
    it("falls back to API v9 when the Paperless instance rejects v10", async () => {
      const acceptedVersions: string[] = [];
      const client = createPaperlessClient(config, {
        fetch: fakeFetch((request) => {
          const accept = request.headers.get("accept") ?? "";
          acceptedVersions.push(accept);
          if (accept.endsWith("version=10")) {
            return jsonResponse(406, { detail: "Invalid version in Accept header." });
          }
          return jsonResponse(200, { count: 0, results: [] });
        }),
      });

      await client.search("receipt");
      await client.search("invoice");

      expect(acceptedVersions).toEqual([
        "application/json; version=10",
        "application/json; version=9",
        "application/json; version=9",
      ]);
    });

    it("rejects an empty query without contacting Paperless", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => {
          throw new Error("should not be called");
        }),
      });
      await expect(client.search("   ")).rejects.toMatchObject({
        code: "paperless_query_invalid",
      });
    });

    it("maps Paperless documents into PaperlessDocumentSummary shapes", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch((request) => {
          expect(request.url).toContain("query=receipt");
          return jsonResponse(200, {
            count: 1,
            results: [
              {
                id: 7,
                title: "Grocery receipt",
                original_file_name: "receipt.pdf",
                mime_type: "application/pdf",
              },
            ],
          });
        }),
      });
      const result = await client.search("receipt");
      expect(result).toEqual({
        count: 1,
        results: [
          {
            id: 7,
            title: "Grocery receipt",
            originalFileName: "receipt.pdf",
            mimeType: "application/pdf",
          },
        ],
      });
    });

    it("maps a 400 to paperless_query_invalid", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          jsonResponse(400, { query: ["Invalid search syntax."] }),
        ),
      });
      await expect(client.search("(((")).rejects.toMatchObject({
        code: "paperless_query_invalid",
      });
    });
  });

  describe("getDocument", () => {
    it("maps a Paperless document into a PaperlessDocumentSummary", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch((request) => {
          expect(request.url).toContain("/api/documents/55/");
          return jsonResponse(200, {
            id: 55,
            title: "Grocery receipt",
            original_file_name: "receipt.pdf",
            mime_type: "application/pdf",
          });
        }),
      });
      const result = await client.getDocument(55);
      expect(result).toEqual({
        id: 55,
        title: "Grocery receipt",
        originalFileName: "receipt.pdf",
        mimeType: "application/pdf",
      });
    });

    it("defaults a missing original_file_name/mime_type to empty/null", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          jsonResponse(200, { id: 9, title: "Untitled" }),
        ),
      });
      const result = await client.getDocument(9);
      expect(result).toEqual({
        id: 9,
        title: "Untitled",
        originalFileName: "",
        mimeType: null,
      });
    });

    it("maps a 404 to paperless_document_not_found", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => jsonResponse(404, { detail: "Not found." })),
      });
      await expect(client.getDocument(9999)).rejects.toMatchObject({
        code: "paperless_document_not_found",
        statusCode: 404,
      });
    });

    it("maps a 401/403 to paperless_authentication_failed", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => jsonResponse(401, { detail: "Unauthorized." })),
      });
      await expect(client.getDocument(1)).rejects.toMatchObject({
        code: "paperless_authentication_failed",
      });
    });
  });

  describe("binary endpoints", () => {
    it("streams a thumbnail with the upstream content type and length", async () => {
      const bytes = Buffer.from([1, 2, 3, 4]);
      const client = createPaperlessClient(config, {
        fetch: fakeFetch((request) => {
          expect(request.url).toContain("/api/documents/42/thumb/");
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "image/webp",
              "content-length": String(bytes.length),
            },
          });
        }),
      });
      const binary = await client.thumbnail(42);
      expect(binary.contentType).toBe("image/webp");
      expect(binary.contentLength).toBe(4);
      expect(await streamToBuffer(binary.body)).toEqual(bytes);
    });

    it("parses the filename from a Content-Disposition header on download", async () => {
      const bytes = Buffer.from("file-bytes");
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() =>
          new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition":
                'attachment; filename="Grocery Receipt.pdf"',
            },
          }),
        ),
      });
      const binary = await client.download(7);
      expect(binary.filename).toBe("Grocery Receipt.pdf");
    });

    it("maps a 404 to paperless_document_not_found for preview and download", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => new Response("not found", { status: 404 })),
      });
      await expect(client.preview(999)).rejects.toMatchObject({
        code: "paperless_document_not_found",
      });
      await expect(client.download(999)).rejects.toMatchObject({
        code: "paperless_document_not_found",
      });
    });

    it("maps a 401/403 to paperless_authentication_failed", async () => {
      const client = createPaperlessClient(config, {
        fetch: fakeFetch(() => new Response("forbidden", { status: 403 })),
      });
      await expect(client.thumbnail(1)).rejects.toMatchObject({
        code: "paperless_authentication_failed",
      });
    });
  });
});

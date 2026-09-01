import { Readable } from "node:stream";
import createClient from "openapi-fetch";
import type { PaperlessDocumentSummary } from "@machbar/shared";
import type { PaperlessConfig } from "../env.js";
import { AppError } from "../errors.js";
import type { components, paths } from "./schema.js";

/** The Paperless-ngx REST API version Machbar targets (see openapi/paperless.yaml). */
const API_VERSION = 10;
const COMPATIBLE_API_VERSION = 9;

const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface PaperlessUploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface PaperlessUploadResult {
  taskId: string;
}

export interface PaperlessPollOptions {
  /** Maximum total time to wait for consumption to finish. */
  timeoutMs?: number;
  /** Delay between task status polls. */
  intervalMs?: number;
}

export interface PaperlessSearchOptions {
  page?: number;
  pageSize?: number;
}

export interface PaperlessSearchResult {
  count: number;
  results: PaperlessDocumentSummary[];
}

/** A binary Paperless response (thumbnail, preview, or download), streamed. */
export interface PaperlessBinary {
  contentType: string;
  contentLength: number | null;
  filename: string | null;
  body: Readable;
}

export interface PaperlessClient {
  upload(input: PaperlessUploadInput): Promise<PaperlessUploadResult>;
  /** Bounded-polls the consumption task until it resolves to a document ID. */
  awaitDocumentId(
    taskId: string,
    options?: PaperlessPollOptions,
  ): Promise<number>;
  /** Fetches a single document's metadata, e.g. right after it was consumed. */
  getDocument(documentId: number): Promise<PaperlessDocumentSummary>;
  search(
    query: string,
    options?: PaperlessSearchOptions,
  ): Promise<PaperlessSearchResult>;
  thumbnail(documentId: number): Promise<PaperlessBinary>;
  preview(documentId: number): Promise<PaperlessBinary>;
  download(documentId: number): Promise<PaperlessBinary>;
}

export interface PaperlessClientOptions {
  /** Overridable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Overridable for tests so bounded polling does not sleep in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable clock for tests. */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailable(cause?: unknown): AppError {
  return new AppError(
    502,
    "paperless_unavailable",
    "Paperless is currently unavailable.",
    cause instanceof Error ? { cause: cause.message } : undefined,
  );
}

function authenticationFailed(): AppError {
  return new AppError(
    502,
    "paperless_authentication_failed",
    "Paperless rejected the configured API token.",
  );
}

function responseInvalid(message: string): AppError {
  return new AppError(502, "paperless_response_invalid", message);
}

/** Extracts the `filename` parameter from a `Content-Disposition` header. */
function parseFilename(header: string | null): string | null {
  if (!header) return null;
  const starMatch = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (starMatch?.[1]) {
    try {
      return decodeURIComponent(starMatch[1]);
    } catch {
      return starMatch[1];
    }
  }
  const match = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

/** Projects a raw Paperless document into the shared summary shape. */
function toSummary(
  document: components["schemas"]["PaperlessDocument"],
): PaperlessDocumentSummary {
  return {
    id: document.id,
    title: document.title,
    originalFileName: document.original_file_name ?? "",
    mimeType: document.mime_type ?? null,
  };
}

function toBinary(response: Response, body: ReadableStream<Uint8Array> | null): PaperlessBinary {
  if (!body) {
    throw responseInvalid("Paperless returned an empty file body.");
  }
  const contentLengthHeader = response.headers.get("content-length");
  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    contentLength: contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null,
    filename: parseFilename(response.headers.get("content-disposition")),
    body: Readable.fromWeb(
      body as Parameters<typeof Readable.fromWeb>[0],
    ),
  };
}

/** Builds a thin typed client for the Paperless-ngx endpoints Machbar uses:
 * upload, bounded task polling to a document ID, search, and the binary
 * thumbnail/preview/download endpoints. Token auth and API version 10 are
 * applied to every request (see docs/architecture-rules.md's canonical
 * primitive registry and openapi/paperless.yaml for the endpoint contracts
 * this client relies on). Older servers that reject version 10 are retried
 * with the compatible version 9 contract. */
export function createPaperlessClient(
  config: PaperlessConfig,
  options: PaperlessClientOptions = {},
): PaperlessClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  let apiVersion = API_VERSION;
  const versionedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("Accept", `application/json; version=${apiVersion}`);
    const versionedRequest = new Request(request, { headers });
    const fallbackRequest =
      apiVersion === API_VERSION ? versionedRequest.clone() : null;
    const response = await fetchImpl(versionedRequest);
    if (response.status !== 406 || !fallbackRequest) return response;

    apiVersion = COMPATIBLE_API_VERSION;
    const fallbackHeaders = new Headers(fallbackRequest.headers);
    fallbackHeaders.set(
      "Accept",
      `application/json; version=${COMPATIBLE_API_VERSION}`,
    );
    return fetchImpl(new Request(fallbackRequest, { headers: fallbackHeaders }));
  };
  const client = createClient<paths>({
    baseUrl: config.baseUrl,
    fetch: versionedFetch,
    headers: {
      Authorization: `Token ${config.apiToken}`,
    },
  });

  async function fetchTaskByUuid(
    taskId: string,
  ): Promise<components["schemas"]["PaperlessTask"] | null> {
    let result;
    try {
      result = await client.GET("/api/tasks/", {
        params: { query: { task_id: taskId } },
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (result.response.status === 401 || result.response.status === 403) {
      throw authenticationFailed();
    }
    if (!result.response.ok) {
      throw unavailable();
    }
    const task = result.data?.results?.[0];
    return task ?? null;
  }

  return {
    async upload({ filename, contentType, data }) {
      const form = new FormData();
      form.append(
        "document",
        new Blob([new Uint8Array(data)], {
          type: contentType || "application/octet-stream",
        }),
        filename,
      );

      let result;
      try {
        result = await client.POST("/api/documents/post_document/", {
          body: form as unknown as {
            document: string;
          },
          bodySerializer: (body) => body as unknown as FormData,
        });
      } catch (cause) {
        throw unavailable(cause);
      }

      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 400) {
        throw AppError.badRequest(
          "paperless_upload_rejected",
          "Paperless rejected the uploaded file.",
          { paperless: result.error ?? null },
        );
      }
      if (!result.response.ok) {
        throw unavailable();
      }
      if (typeof result.data !== "string" || result.data.length === 0) {
        throw responseInvalid(
          "Paperless did not return a task ID for the upload.",
        );
      }
      return { taskId: result.data };
    },

    async awaitDocumentId(taskId, pollOptions = {}) {
      const timeoutMs = pollOptions.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
      const intervalMs = pollOptions.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const deadline = now() + timeoutMs;

      for (;;) {
        const task = await fetchTaskByUuid(taskId);
        if (task) {
          if (task.status === "success") {
            const documentId = task.related_document_ids[0];
            if (typeof documentId === "number" && documentId > 0) {
              return documentId;
            }
            throw responseInvalid(
              "Paperless reported a successful upload without a document ID.",
            );
          }
          if (task.status === "failure" || task.status === "revoked") {
            throw AppError.badRequest(
              "paperless_upload_rejected",
              "Paperless failed to process the uploaded document.",
              { status: task.status, result: task.result_data ?? null },
            );
          }
        }
        if (now() >= deadline) {
          throw new AppError(
            504,
            "paperless_processing_timeout",
            "Timed out waiting for Paperless to finish processing the document.",
          );
        }
        await sleep(intervalMs);
      }
    },

    async search(query, searchOptions = {}) {
      if (!query.trim()) {
        throw AppError.badRequest(
          "paperless_query_invalid",
          "A search query is required.",
        );
      }
      let result;
      try {
        result = await client.GET("/api/documents/", {
          params: {
            query: {
              query,
              ...(searchOptions.page !== undefined
                ? { page: searchOptions.page }
                : {}),
              ...(searchOptions.pageSize !== undefined
                ? { page_size: searchOptions.pageSize }
                : {}),
            },
          },
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 400) {
        throw AppError.badRequest(
          "paperless_query_invalid",
          "Paperless rejected the search query.",
          { paperless: result.error ?? null },
        );
      }
      if (!result.response.ok || !result.data) {
        throw unavailable();
      }
      return {
        count: result.data.count,
        results: result.data.results.map(toSummary),
      };
    },

    async getDocument(documentId) {
      let result;
      try {
        result = await client.GET("/api/documents/{id}/", {
          params: { path: { id: documentId } },
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 404) {
        throw AppError.notFound(
          "paperless_document_not_found",
          "The Paperless document was not found.",
          { documentId },
        );
      }
      if (!result.response.ok || !result.data) {
        throw unavailable();
      }
      return toSummary(result.data);
    },

    async thumbnail(documentId) {
      let result;
      try {
        result = await client.GET("/api/documents/{id}/thumb/", {
          params: { path: { id: documentId } },
          parseAs: "stream",
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 404) {
        throw AppError.notFound(
          "paperless_document_not_found",
          "The Paperless document was not found.",
          { documentId },
        );
      }
      if (!result.response.ok) {
        throw unavailable();
      }
      return toBinary(result.response, result.data ?? null);
    },

    async preview(documentId) {
      let result;
      try {
        result = await client.GET("/api/documents/{id}/preview/", {
          params: { path: { id: documentId } },
          parseAs: "stream",
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 404) {
        throw AppError.notFound(
          "paperless_document_not_found",
          "The Paperless document was not found.",
          { documentId },
        );
      }
      if (!result.response.ok) {
        throw unavailable();
      }
      return toBinary(result.response, result.data ?? null);
    },

    async download(documentId) {
      let result;
      try {
        result = await client.GET("/api/documents/{id}/download/", {
          params: { path: { id: documentId } },
          parseAs: "stream",
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (result.response.status === 401 || result.response.status === 403) {
        throw authenticationFailed();
      }
      if (result.response.status === 404) {
        throw AppError.notFound(
          "paperless_document_not_found",
          "The Paperless document was not found.",
          { documentId },
        );
      }
      if (!result.response.ok) {
        throw unavailable();
      }
      return toBinary(result.response, result.data ?? null);
    },
  };
}

import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Env } from "../env.js";
import { AppError } from "../errors.js";
import type { PaperlessBinary, PaperlessClient } from "../paperless/client.js";

const BASE_PATH = "/api/integrations/paperless/documents";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function requireClient(env: Env, client?: PaperlessClient): PaperlessClient {
  if (!env.paperless || !client) {
    throw AppError.badRequest(
      "paperless_not_configured",
      "Paperless is not configured.",
    );
  }
  return client;
}

function parseDocumentId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== raw) {
    throw AppError.badRequest(
      "identifier_invalid",
      "The Paperless document ID must be a positive number.",
      { resource: "paperlessDocument", value: raw },
    );
  }
  return id;
}

function sendBinary(
  reply: FastifyReply,
  binary: PaperlessBinary,
  disposition: "inline" | "attachment",
): FastifyReply {
  reply.header("content-type", binary.contentType);
  if (binary.contentLength !== null) {
    reply.header("content-length", binary.contentLength);
  }
  if (binary.filename) {
    reply.header(
      "content-disposition",
      `${disposition}; filename="${binary.filename.replace(/"/g, "")}"`,
    );
  } else {
    reply.header("content-disposition", disposition);
  }
  return reply.send(binary.body);
}

export function registerPaperlessRoutes(
  app: FastifyInstance,
  env: Env,
  client?: PaperlessClient,
): void {
  app.register(async (instance) => {
    await instance.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      throwFileSizeLimit: false,
    });

    instance.post(
      BASE_PATH,
      { bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024 },
      async (request) => {
        const paperless = requireClient(env, client);
        const file = await request.file({
          limits: { fileSize: MAX_UPLOAD_BYTES },
          throwFileSizeLimit: false,
        });
        if (!file) {
          throw AppError.badRequest(
            "paperless_upload_rejected",
            "A file is required.",
          );
        }
        const data = await file.toBuffer();
        if (file.file.truncated) {
          throw AppError.badRequest(
            "paperless_file_too_large",
            "The uploaded file exceeds the 25MB limit.",
            { maxBytes: MAX_UPLOAD_BYTES },
          );
        }

        const { taskId } = await paperless.upload({
          filename: file.filename,
          contentType: file.mimetype,
          data,
        });
        const documentId = await paperless.awaitDocumentId(taskId);
        return paperless.getDocument(documentId);
      },
    );

    instance.get<{ Querystring: { query?: string; page?: string; pageSize?: string } }>(
      BASE_PATH,
      async (request) => {
        const paperless = requireClient(env, client);
        const query = request.query.query?.trim();
        if (!query) {
          throw AppError.badRequest(
            "paperless_query_invalid",
            "A search query is required.",
          );
        }
        const page = request.query.page
          ? Number.parseInt(request.query.page, 10)
          : undefined;
        const pageSize = request.query.pageSize
          ? Number.parseInt(request.query.pageSize, 10)
          : undefined;
        const { results } = await paperless.search(query, {
          ...(page !== undefined && !Number.isNaN(page) ? { page } : {}),
          ...(pageSize !== undefined && !Number.isNaN(pageSize)
            ? { pageSize }
            : {}),
        });
        return results;
      },
    );

    instance.get<{ Params: { id: string } }>(
      `${BASE_PATH}/:id/thumbnail`,
      async (request, reply) => {
        const paperless = requireClient(env, client);
        const id = parseDocumentId(request.params.id);
        const binary = await paperless.thumbnail(id);
        return sendBinary(reply, binary, "inline");
      },
    );

    instance.get<{ Params: { id: string } }>(
      `${BASE_PATH}/:id/preview`,
      async (request, reply) => {
        const paperless = requireClient(env, client);
        const id = parseDocumentId(request.params.id);
        const binary = await paperless.preview(id);
        return sendBinary(reply, binary, "inline");
      },
    );

    instance.get<{ Params: { id: string } }>(
      `${BASE_PATH}/:id/download`,
      async (request, reply) => {
        const paperless = requireClient(env, client);
        const id = parseDocumentId(request.params.id);
        const binary = await paperless.download(id);
        return sendBinary(reply, binary, "attachment");
      },
    );
  });
}

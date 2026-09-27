import multipart from "@fastify/multipart";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import type { PaperlessClient } from "../paperless/client.js";
import { AppError } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import {
  createIntakeJob,
  deleteIntake,
  getIntake,
  retryIntakeAnalysis,
  updateIntakeDraft,
  purgeExpiredIntakes,
} from "../intake/jobs.js";
import { applyIntake } from "../intake/apply.js";
import { HomeAssistantRequestSignal } from "../integrations/homeAssistantRequests.js";
import { intakeDraftSchema } from "../schemas.js";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "application/pdf", "text/plain"]);

function actor(request: { activityActor?: { id: number } | null; authMember?: { id: number } | null }) {
  return request.activityActor?.id ?? null;
}

async function parseMultipart(request: any) {
  let text: string | null = null;
  let scope: "household" | "work" = "household";
  const files: Array<{ filename: string; mimeType: string; data: Buffer }> = [];
  for await (const part of request.parts({ limits: { files: 5, fileSize: MAX_BYTES, fields: 3 } })) {
    if (part.type === "field") {
    if (part.fieldname === "text") {
      const value = String(part.value).trim();
      if (value.length > 20_000) {
        throw AppError.badRequest("intake_file_too_large", "The intake text exceeds the 20,000 character limit.");
      }
      text = value || null;
    }
      if (part.fieldname === "scope" && (part.value === "household" || part.value === "work")) scope = part.value;
      continue;
    }
    if (!ALLOWED.has(part.mimetype)) throw AppError.badRequest("intake_file_rejected", "This file type is not supported.");
    const data = await part.toBuffer();
    if (data.length > MAX_BYTES || part.file.truncated) throw AppError.badRequest("intake_file_too_large", "The uploaded file exceeds the 25MB limit.");
    let normalized = data;
    let mimeType = part.mimetype;
    if (part.mimetype.startsWith("image/")) {
      try {
        normalized = await sharp(data, { limitInputPixels: 64_000_000 }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        mimeType = "image/jpeg";
      } catch {
        throw AppError.badRequest("intake_file_rejected", "The image could not be processed.");
      }
    }
    files.push({ filename: part.filename, mimeType, data: normalized });
  }
  if (!text && files.length === 0) throw AppError.badRequest("intake_input_required", "Text or at least one file is required.");
  return { text, scope, files };
}

export function registerIntakeRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  paperless: PaperlessClient | undefined,
  signal: HomeAssistantRequestSignal = new HomeAssistantRequestSignal(),
): void {
  app.register(async (instance) => {
    await instance.register(multipart, { limits: { files: 5, fileSize: MAX_BYTES, fields: 3 }, throwFileSizeLimit: false });
    instance.post("/api/intake", { bodyLimit: MAX_BYTES * 5 + 1024 * 1024 }, async (request, reply) => {
      await purgeExpiredIntakes(db, env);
      const parsed = await parseMultipart(request);
      const id = await createIntakeJob(db, env, signal, {
        ...parsed,
        actorMemberId: actor(request),
        createdByMemberId: request.authMember?.id ?? actor(request),
      });
      reply.status(201);
      return { id };
    });
  });

  app.get<{ Params: { id: string } }>("/api/intake/:id", async (request) =>
    getIntake(db, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null, Boolean(paperless)));

  app.patch<{ Params: { id: string } }>("/api/intake/:id/plan", async (request) => {
    const body = request.body as { expectedRevision: number; draft: unknown };
    const draft = parseOrThrow(intakeDraftSchema, body?.draft);
    updateIntakeDraft(db, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null, {
      expectedRevision: body.expectedRevision,
      draft,
    }, {
      paperlessAvailable: Boolean(paperless),
      hasFiles: Boolean(db.select().from(schema.intakeAttachments).all().find((file) => file.intakeJobId === request.params.id)),
    });
    return getIntake(db, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null, Boolean(paperless));
  });

  app.post<{ Params: { id: string } }>("/api/intake/:id/apply", async (request) => {
    const body = request.body as { expectedRevision: number; draft: unknown };
    const draft = parseOrThrow(intakeDraftSchema, body?.draft);
    await applyIntake(db, env, paperless, signal, request.params.id, { expectedRevision: body.expectedRevision, draft }, { actorMemberId: request.activityActor?.id ?? null }, request.authMember?.id ?? request.activityActor?.id ?? null);
    return getIntake(db, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null, Boolean(paperless));
  });

  app.post<{ Params: { id: string } }>("/api/intake/:id/retry", async (request) => {
    await retryIntakeAnalysis(db, env, signal, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null);
    return getIntake(db, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null, Boolean(paperless));
  });

  app.delete<{ Params: { id: string } }>("/api/intake/:id", async (request, reply) => {
    await deleteIntake(db, env, request.params.id, request.authMember?.id ?? request.activityActor?.id ?? null);
    reply.status(204);
    return null;
  });
}

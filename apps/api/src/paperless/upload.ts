import type { PaperlessDocumentSummary } from "@machbar/shared";
import { AppError } from "../errors.js";
import type { PaperlessClient } from "./client.js";

export async function uploadAndResolveDocument(
  paperless: PaperlessClient,
  input: { filename: string; contentType: string; data: Buffer },
): Promise<PaperlessDocumentSummary> {
  try {
    const { taskId } = await paperless.upload(input);
    const id = await paperless.awaitDocumentId(taskId);
    return await paperless.getDocument(id);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "paperless_unavailable", "Paperless is currently unavailable.");
  }
}

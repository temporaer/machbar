import type { z } from "zod";
import { AppError } from "./errors.js";

/** Parses `input` with the given zod schema, throwing a German AppError on failure. */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw AppError.badRequest(
      "Die Anfrage enthält ungültige Daten.",
      result.error.flatten(),
    );
  }
  return result.data;
}

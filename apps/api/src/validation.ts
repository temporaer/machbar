import type { ApiErrorCode } from "@machbar/shared";
import type { z } from "zod";
import { AppError } from "./errors.js";

export function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map(({ message: _message, ...issue }) => issue),
  };
}

/** Parses input and exposes machine-readable Zod issue codes and paths. */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  error: {
    code: ApiErrorCode;
    message: string;
  } = {
    code: "request_body_invalid",
    message: "The request contains invalid data.",
  },
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw AppError.badRequest(
      error.code,
      error.message,
      validationDetails(result.error),
    );
  }
  return result.data;
}

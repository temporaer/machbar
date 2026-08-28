import type { ApiErrorCode } from "@machbar/shared";

/** Application error with a stable client-facing code and English fallback. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static notFound(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(404, code, message, details);
  }

  static badRequest(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(400, code, message, details);
  }

  static conflict(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(409, code, message, details);
  }

  static unauthorized(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(401, code, message, details);
  }

  static forbidden(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(403, code, message, details);
  }
}

/**
 * Application error carrying a user-facing German message and an HTTP
 * status code. Route handlers catch this and translate it into a JSON
 * error response; anything else is treated as an unexpected 500 error.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static notFound(message: string): AppError {
    return new AppError(404, "not_found", message);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, "bad_request", message, details);
  }

  static conflict(message: string): AppError {
    return new AppError(409, "conflict", message);
  }
}

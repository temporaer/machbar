import type {
  ApiErrorCode,
  ProjectStatus,
} from "@machbar/shared";
import type { ProjectWorkflowAction } from "./api";
import type { Strings } from "./strings";

function isApiError(
  error: unknown,
): error is Error & {
  code?: ApiErrorCode | undefined;
  details?: Record<string, unknown> | undefined;
} {
  return error instanceof Error && error.name === "ApiError";
}

export function isStaleWriteConflict(error: unknown): boolean {
  return isApiError(error) && error.code === "stale_write_conflict";
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isProjectStatus(value: string | null): value is ProjectStatus {
  return (
    value === "backlog" ||
    value === "active" ||
    value === "completed" ||
    value === "archived"
  );
}

function isProjectWorkflowAction(
  value: string | null,
): value is ProjectWorkflowAction {
  return (
    value === "activate" ||
    value === "return_to_backlog" ||
    value === "complete" ||
    value === "reopen" ||
    value === "archive"
  );
}

function projectWorkflowActionLabel(
  action: ProjectWorkflowAction,
  strings: Strings,
): string {
  return {
    activate: strings.activateStory,
    return_to_backlog: strings.returnToBacklogStory,
    complete: strings.completeStory,
    reopen: strings.reopen,
    archive: strings.archiveStory,
  }[action];
}

export function localizedApiErrorMessage(
  code: ApiErrorCode,
  details: Record<string, unknown> | undefined,
  strings: Strings,
): string {
  const name = stringDetail(details, "name");
  if (name) {
    if (code === "member_name_conflict") {
      return strings.apiErrorMemberNameConflict(name);
    }
    if (code === "tag_name_conflict") {
      return strings.apiErrorTagNameConflict(name);
    }
    if (code === "tag_kind_conflict") {
      return strings.apiErrorTagKindConflict(name);
    }
    if (code === "oidc_name_conflict") {
      return strings.apiErrorOidcNameConflict(name);
    }
  }

  if (code === "task_sequence_too_short") {
    const minimum = numberDetail(details, "minimum");
    if (minimum !== undefined) {
      return strings.apiErrorTaskSequenceTooShort(
        minimum,
        numberDetail(details, "provided"),
      );
    }
  }

  if (code === "project_transition_invalid") {
    const currentStatus = stringDetail(details, "currentStatus");
    const action = stringDetail(details, "action");
    if (isProjectStatus(currentStatus) && isProjectWorkflowAction(action)) {
      return strings.apiErrorProjectTransitionInvalid(
        strings.projectStatusLabels[currentStatus],
        projectWorkflowActionLabel(action, strings),
      );
    }
  }

  return strings.apiErrorMessages[code];
}

/**
 * API prose is only an English fallback for logs and non-localized clients.
 * The web UI uses the stable error code as its integration boundary.
 */
export function localizedErrorMessage(
  error: unknown,
  strings: Strings,
): string {
  if (isApiError(error)) {
    if (
      error.code &&
      Object.prototype.hasOwnProperty.call(strings.apiErrorMessages, error.code)
    ) {
      return localizedApiErrorMessage(error.code, error.details, strings);
    }
    return strings.error;
  }
  return error instanceof Error ? error.message : String(error);
}

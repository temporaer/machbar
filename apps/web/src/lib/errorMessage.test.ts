import { describe, expect, it } from "vitest";
import { de } from "../i18n/de";
import { en } from "../i18n/en";
import { ApiError } from "./api";
import { localizedErrorMessage } from "./errorMessage";

describe("localizedErrorMessage", () => {
  it("uses stable API codes rather than server fallback prose", () => {
    const error = new ApiError(
      404,
      "The task could not be found.",
      "task_not_found",
    );

    expect(localizedErrorMessage(error, de)).toBe(
      "Die Aufgabe wurde nicht gefunden.",
    );
    expect(localizedErrorMessage(error, en)).toBe(
      "The task could not be found.",
    );
  });

  it("preserves local network and browser errors", () => {
    expect(localizedErrorMessage(new Error("offline"), de)).toBe("offline");
  });

  it("uses safe structured details for parameterized translations", () => {
    expect(
      localizedErrorMessage(
        new ApiError(
          409,
          "A member with this name already exists.",
          "member_name_conflict",
          { name: "Mira" },
        ),
        de,
      ),
    ).toBe("Eine Person mit dem Namen „Mira“ ist bereits vorhanden.");

    expect(
      localizedErrorMessage(
        new ApiError(
          400,
          "A task sequence requires at least two named steps.",
          "task_sequence_too_short",
          { minimum: 2, provided: 1 },
        ),
        en,
      ),
    ).toBe("A task sequence needs at least 2 named steps; 1 was provided.");
  });

  it("localizes status and action details for invalid project transitions", () => {
    expect(
      localizedErrorMessage(
        new ApiError(
          409,
          "The requested project status transition is not allowed.",
          "project_transition_invalid",
          { currentStatus: "completed", action: "complete" },
        ),
        de,
      ),
    ).toBe(
      "Das Projekt kann im Status „Abgeschlossen“ nicht mit „Abschließen“ fortgesetzt werden.",
    );
  });
});

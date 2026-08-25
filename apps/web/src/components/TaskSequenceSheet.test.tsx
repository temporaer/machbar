import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { TaskSequenceSheet } from "./TaskSequenceSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTaskSequence: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskSequenceSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
  });

  it("creates one atomic sequence from trimmed non-empty lines", async () => {
    mockedApi.createTaskSequence.mockResolvedValue([]);
    const onClose = vi.fn();
    renderWithProviders(
      <TaskSequenceSheet projectId={7} onClose={onClose} />,
    );

    await userEvent.type(
      screen.getByLabelText("Schritte in Reihenfolge"),
      "  Angebot einholen  \n\nTermin vereinbaren\nRechnung bezahlen ",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "3 Schritte hinzufügen" }),
    );

    await waitFor(() =>
      expect(mockedApi.createTaskSequence).toHaveBeenCalledWith(7, {
        titles: [
          "Angebot einholen",
          "Termin vereinbaren",
          "Rechnung bezahlen",
        ],
        createdByMemberId: null,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps all entered steps visible when creation fails", async () => {
    mockedApi.createTaskSequence.mockRejectedValue(new Error("Nicht gespeichert"));
    renderWithProviders(
      <TaskSequenceSheet projectId={7} onClose={vi.fn()} />,
    );

    const input = screen.getByLabelText("Schritte in Reihenfolge");
    await userEvent.type(input, "Erster Schritt\nZweiter Schritt");
    await userEvent.click(
      screen.getByRole("button", { name: "2 Schritte hinzufügen" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nicht gespeichert",
    );
    expect(input).toHaveValue("Erster Schritt\nZweiter Schritt");
  });
});

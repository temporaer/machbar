import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { InlineSuccessorComposer } from "./InlineSuccessorComposer";
import { makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createTaskSuccessor: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("InlineSuccessorComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
  });

  it("creates a clarified actionable successor and refreshes the caller", async () => {
    mockedApi.createTaskSuccessor.mockResolvedValue(
      makeTask({ id: 2, title: "Rechnung bezahlen" }),
    );
    const onCreated = vi.fn();
    renderWithProviders(
      <InlineSuccessorComposer
        predecessorId={1}
        onCancel={vi.fn()}
        onCreated={onCreated}
      />,
    );

    await userEvent.type(
      screen.getByPlaceholderText("Nächster Schritt"),
      "Rechnung bezahlen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createTaskSuccessor).toHaveBeenCalledWith(1, {
        title: "Rechnung bezahlen",
        createdByMemberId: null,
        status: "actionable",
        needsClarification: false,
      }),
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it("cancels without mutation and preserves input on failure", async () => {
    const onCancel = vi.fn();
    mockedApi.createTaskSuccessor.mockRejectedValue(
      new Error("Verbindung fehlgeschlagen"),
    );
    renderWithProviders(
      <InlineSuccessorComposer
        predecessorId={1}
        onCancel={onCancel}
        onCreated={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText("Nächster Schritt");
    await userEvent.type(input, "Termin vereinbaren");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Verbindung fehlgeschlagen",
    );
    expect(input).toHaveValue("Termin vereinbaren");

    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalled();
    expect(mockedApi.createTaskSuccessor).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate submissions while creation is pending", async () => {
    mockedApi.createTaskSuccessor.mockReturnValue(new Promise(() => {}));
    renderWithProviders(
      <InlineSuccessorComposer
        predecessorId={1}
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await userEvent.type(
      screen.getByPlaceholderText("Nächster Schritt"),
      "Termin vereinbaren",
    );
    const form = screen.getByRole("form", {
      name: "Nächsten Schritt danach hinzufügen",
    });

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(mockedApi.createTaskSuccessor).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { InlineTaskComposer } from "./InlineTaskComposer";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("InlineTaskComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
  });

  it("focuses the draft and cancels with Escape without saving", async () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    renderWithProviders(
      <InlineTaskComposer
        inputId="task-title"
        label="Neue Aufgabe"
        placeholder="Titel"
        onCancel={onCancel}
        onSave={onSave}
      />,
    );

    const input = screen.getByPlaceholderText("Titel");
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, "Entwurf{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("guards duplicate submits synchronously and locks controls while pending", async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderWithProviders(
      <InlineTaskComposer
        inputId="task-title"
        label="Neue Aufgabe"
        placeholder="Titel"
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Titel"), "  Aufgabe  ");
    const form = screen.getByRole("form", { name: "Neue Aufgabe" });

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Aufgabe");
    expect(screen.getByPlaceholderText("Titel")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeDisabled();
    resolveSave();
  });

  it("keeps the draft, surfaces failure, and permits a retry", async () => {
    const onSave = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Netzwerkfehler"))
      .mockResolvedValueOnce();
    renderWithProviders(
      <InlineTaskComposer
        inputId="task-title"
        label="Neue Aufgabe"
        placeholder="Titel"
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    const input = screen.getByPlaceholderText("Titel");
    await userEvent.type(input, "Belege sammeln");

    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Netzwerkfehler");
    expect(input).toHaveValue("Belege sammeln");
    expect(input).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});

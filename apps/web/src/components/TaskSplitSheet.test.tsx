import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { TaskSplitSheet } from "./TaskSplitSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    createChildTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("TaskSplitSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
  });

  it("creates one child task per filled row, always keeping one empty trailing row", async () => {
    mockedApi.createChildTask.mockResolvedValue({} as never);
    const onClose = vi.fn();
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={onClose} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    expect(rows()).toHaveLength(1);

    await userEvent.type(rows()[0]!, "Pakete prüfen{enter}");
    expect(rows()).toHaveLength(2);
    await userEvent.type(rows()[1]!, "Korpus aufbauen{enter}");
    expect(rows()).toHaveLength(3);
    await userEvent.type(rows()[2]!, "Türen montieren");

    await userEvent.click(screen.getByRole("button", { name: "3 Teilaufgaben anlegen" }));

    await waitFor(() => expect(mockedApi.createChildTask).toHaveBeenCalledTimes(3));
    expect(mockedApi.createChildTask).toHaveBeenNthCalledWith(1, 7, {
      title: "Pakete prüfen",
      createdByMemberId: null,
      status: "actionable",
    });
    expect(mockedApi.createChildTask).toHaveBeenNthCalledWith(3, 7, {
      title: "Türen montieren",
      createdByMemberId: null,
      status: "actionable",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("removes a filled row without affecting the others", async () => {
    mockedApi.createChildTask.mockResolvedValue({} as never);
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    await userEvent.type(rows()[0]!, "Erster Schritt{enter}");
    await userEvent.type(rows()[1]!, "Zweiter Schritt");

    await userEvent.click(screen.getAllByRole("button", { name: "Schritt entfernen" })[0]!);
    expect(rows().map((row) => (row as HTMLInputElement).value)).toEqual(["Zweiter Schritt", ""]);
  });

  it("keeps the entered rows and reports a failed child creation", async () => {
    mockedApi.createChildTask.mockRejectedValue(new Error("Nicht gespeichert"));
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);

    const rows = () => screen.getAllByPlaceholderText("Schritt …");
    await userEvent.type(rows()[0]!, "Erster Schritt{enter}");
    await userEvent.type(rows()[1]!, "Zweiter Schritt");
    await userEvent.click(screen.getByRole("button", { name: "2 Teilaufgaben anlegen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nicht gespeichert");
    expect(rows().map((row) => (row as HTMLInputElement).value)).toEqual([
      "Erster Schritt",
      "Zweiter Schritt",
      "",
    ]);
  });
});

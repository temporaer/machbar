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

  it("creates each entered child task from one split session", async () => {
    mockedApi.createChildTask.mockResolvedValue({} as never);
    const onClose = vi.fn();
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={onClose} />);

    const input = screen.getByLabelText("Schritte");
    await userEvent.type(input, "Pakete prüfen\n\nKorpus aufbauen\nTüren montieren");
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

  it("keeps the entered outline and reports a failed child creation", async () => {
    mockedApi.createChildTask.mockRejectedValue(new Error("Nicht gespeichert"));
    renderWithProviders(<TaskSplitSheet parentId={7} onClose={vi.fn()} />);

    const input = screen.getByLabelText("Schritte");
    await userEvent.type(input, "Erster Schritt\nZweiter Schritt");
    await userEvent.click(screen.getByRole("button", { name: "2 Teilaufgaben anlegen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nicht gespeichert");
    expect(input).toHaveValue("Erster Schritt\nZweiter Schritt");
  });
});

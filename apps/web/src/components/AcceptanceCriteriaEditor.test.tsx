import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeCriterion, makeProject } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    addCriterion: vi.fn(),
    updateCriterion: vi.fn(),
    checkCriterion: vi.fn(),
    reorderCriteria: vi.fn(),
    removeCriterion: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const criterion = makeCriterion({
  id: 10,
  projectId: 4,
  text: "Kisten sind gepackt",
  checked: false,
});
const project = makeProject({ id: 4, acceptanceCriteria: [criterion] });

describe("AcceptanceCriteriaEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
  });

  it("edits text only through explicit Edit and Save, never on blur", async () => {
    mockedApi.updateCriterion.mockResolvedValue(project);
    renderWithProviders(
      <AcceptanceCriteriaEditor projectId={4} criteria={[criterion]} onError={vi.fn()} />,
    );
    const input = screen.getByDisplayValue("Kisten sind gepackt");
    expect(input).toHaveAttribute("readonly");

    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(input).not.toHaveAttribute("readonly");
    await userEvent.clear(input);
    await userEvent.type(input, "Kisten und Möbel sind gepackt");
    await userEvent.tab();
    expect(mockedApi.updateCriterion).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(mockedApi.updateCriterion).toHaveBeenCalledWith(
        4,
        10,
        "Kisten und Möbel sind gepackt",
      ),
    );
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
  });

  it("restores the original text on Cancel", async () => {
    renderWithProviders(
      <AcceptanceCriteriaEditor projectId={4} criteria={[criterion]} onError={vi.fn()} />,
    );
    const input = screen.getByDisplayValue("Kisten sind gepackt");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    await userEvent.clear(input);
    await userEvent.type(input, "Verwerfen");

    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(input).toHaveValue("Kisten sind gepackt");
    expect(mockedApi.updateCriterion).not.toHaveBeenCalled();
  });

  it("retains a failed edit and reports the error", async () => {
    const onError = vi.fn();
    mockedApi.updateCriterion.mockRejectedValue(new Error("Speichern fehlgeschlagen"));
    renderWithProviders(
      <AcceptanceCriteriaEditor projectId={4} criteria={[criterion]} onError={onError} />,
    );
    const input = screen.getByDisplayValue("Kisten sind gepackt");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    await userEvent.clear(input);
    await userEvent.type(input, "Kisten sind beschriftet");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Speichern fehlgeschlagen"));
    expect(input).toHaveValue("Kisten sind beschriftet");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
  });

  it("prevents overlapping mutations synchronously", async () => {
    let resolveUpdate!: (value: typeof project) => void;
    mockedApi.updateCriterion.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    renderWithProviders(
      <AcceptanceCriteriaEditor projectId={4} criteria={[criterion]} onError={vi.fn()} />,
    );
    const input = screen.getByDisplayValue("Kisten sind gepackt");
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    await userEvent.clear(input);
    await userEvent.type(input, "Kisten sind beschriftet");
    const save = screen.getByRole("button", { name: "Speichern" });

    fireEvent.click(save);
    fireEvent.click(save);

    expect(mockedApi.updateCriterion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Kisten sind gepackt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Kriterium entfernen" })).toBeDisabled();
    resolveUpdate(project);
  });

  it("keeps a failed add draft and leaves immediate operations available afterward", async () => {
    const onError = vi.fn();
    mockedApi.addCriterion.mockRejectedValue(new Error("Hinzufügen fehlgeschlagen"));
    mockedApi.checkCriterion.mockResolvedValue(project);
    renderWithProviders(
      <AcceptanceCriteriaEditor projectId={4} criteria={[criterion]} onError={onError} />,
    );
    const addInput = screen.getByPlaceholderText("Erledigt, wenn …");
    await userEvent.type(addInput, "Transport ist gebucht");
    await userEvent.click(screen.getByRole("button", { name: "Punkt hinzufügen" }));

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Hinzufügen fehlgeschlagen"));
    expect(addInput).toHaveValue("Transport ist gebucht");

    await userEvent.click(screen.getByRole("checkbox", { name: "Kisten sind gepackt" }));
    await waitFor(() => expect(mockedApi.checkCriterion).toHaveBeenCalledWith(4, 10, true));
  });
});

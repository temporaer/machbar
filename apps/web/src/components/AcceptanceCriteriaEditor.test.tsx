import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeCriterion, makeProject } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import { de as strings } from "../i18n/de";

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
      <AcceptanceCriteriaEditor ownerType="project" workItemId={4} criteria={[criterion]} onError={vi.fn()} />,
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
        "project",
        4,
        10,
        "Kisten und Möbel sind gepackt",
      ),
    );
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
  });

  it("restores the original text on Cancel", async () => {
    renderWithProviders(
      <AcceptanceCriteriaEditor ownerType="project" workItemId={4} criteria={[criterion]} onError={vi.fn()} />,
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
      <AcceptanceCriteriaEditor ownerType="project" workItemId={4} criteria={[criterion]} onError={onError} />,
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
      <AcceptanceCriteriaEditor ownerType="project" workItemId={4} criteria={[criterion]} onError={vi.fn()} />,
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
      <AcceptanceCriteriaEditor ownerType="project" workItemId={4} criteria={[criterion]} onError={onError} />,
    );
    const addInput = screen.getByPlaceholderText("Erledigt, wenn …");
    await userEvent.type(addInput, "Transport ist gebucht");
    await userEvent.click(screen.getByRole("button", { name: "Punkt hinzufügen" }));

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Hinzufügen fehlgeschlagen"));
    expect(addInput).toHaveValue("Transport ist gebucht");

    await userEvent.click(screen.getByRole("checkbox", { name: "Kisten sind gepackt" }));
    await waitFor(() => expect(mockedApi.checkCriterion).toHaveBeenCalledWith("project", 4, 10, true));
  });

  it("uses the task criterion routes for criteria retained after conversion", async () => {
    mockedApi.updateCriterion.mockResolvedValue(project);
    renderWithProviders(
      <AcceptanceCriteriaEditor ownerType="task" workItemId={404} criteria={[criterion]} onError={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    const input = screen.getByDisplayValue("Kisten sind gepackt");
    await userEvent.clear(input);
    await userEvent.type(input, "Kisten sind beschriftet");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(mockedApi.updateCriterion).toHaveBeenCalledWith(
      "task", 404, 10, "Kisten sind beschriftet",
    ));
  });

  it.each(["add", "update", "remove", "reorder", "check"] as const)(
    "discards criterion drafts on denied %s without requiring a host to unmount it",
    async operation => {
      const cause = Object.assign(new Error("Raw denial"), { name: "ApiError", status: 403 });
      const onError = vi.fn();
      const onFailure = vi.fn();
      mockedApi.addCriterion.mockRejectedValue(cause);
      mockedApi.updateCriterion.mockRejectedValue(cause);
      mockedApi.removeCriterion.mockRejectedValue(cause);
      mockedApi.reorderCriteria.mockRejectedValue(cause);
      mockedApi.checkCriterion.mockRejectedValue(cause);
      renderWithProviders(<AcceptanceCriteriaEditor ownerType="project" workItemId={4}
        criteria={[criterion, makeCriterion({ id: 11, workItemId: 4, text: "Second criterion", position: 1 })]}
        onError={onError} onFailure={onFailure} />);
      await userEvent.type(screen.getByPlaceholderText(strings.addCriterionPlaceholder), "Private add draft");
      const row = screen.getByRole("checkbox", { name: criterion.text }).closest<HTMLElement>(".criterion-row")!;
      if (operation === "update") {
        await userEvent.click(within(row).getByRole("button", { name: strings.edit }));
        await userEvent.type(within(row).getByRole("textbox"), " private edit");
        await userEvent.click(within(row).getByRole("button", { name: strings.save }));
      } else if (operation === "add") {
        await userEvent.click(screen.getByRole("button", { name: strings.addCriterion }));
      } else if (operation === "remove") {
        await userEvent.click(within(row).getByRole("button", { name: strings.removeCriterion }));
      } else if (operation === "reorder") {
        await userEvent.click(within(row).getByRole("button", { name: strings.moveCriterionDown }));
      } else {
        await userEvent.click(within(row).getByRole("checkbox"));
      }
      await waitFor(() => expect(onError).toHaveBeenLastCalledWith(strings.error));
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
      expect(screen.getByPlaceholderText(strings.addCriterionPlaceholder)).toHaveValue("");
      expect(within(row).getByRole("textbox")).toHaveValue(criterion.text);
      expect(within(row).getByRole("textbox")).toHaveAttribute("readonly");
    },
  );

  it("does not forward a retired editor's denied write into a replacement identity", async () => {
    let deny!: (cause: unknown) => void;
    mockedApi.updateCriterion.mockReturnValue(new Promise((_resolve, reject) => { deny = reject; }));
    const retiredError = vi.fn();
    const retiredFailure = vi.fn();
    const currentError = vi.fn();
    const currentFailure = vi.fn();
    const { rerender } = renderWithProviders(
      <AcceptanceCriteriaEditor key="old-identity" ownerType="task" workItemId={4} criteria={[criterion]}
        onError={retiredError} onFailure={retiredFailure} />,
    );
    await userEvent.click(screen.getByRole("button", { name: strings.edit }));
    await userEvent.type(screen.getByDisplayValue(criterion.text), " old draft");
    await userEvent.click(screen.getByRole("button", { name: strings.save }));
    retiredError.mockClear();
    rerender(
      <AcceptanceCriteriaEditor key="new-identity" ownerType="task" workItemId={4} criteria={[criterion]}
        onError={currentError} onFailure={currentFailure} />,
    );
    await userEvent.click(screen.getByRole("button", { name: strings.edit }));
    await userEvent.type(screen.getByDisplayValue(criterion.text), " current draft");
    await act(async () => { deny(Object.assign(new Error("Old denial"), { name: "ApiError", status: 403 })); });
    expect(screen.getByDisplayValue(`${criterion.text} current draft`)).not.toHaveAttribute("readonly");
    expect(retiredError).not.toHaveBeenCalled();
    expect(retiredFailure).not.toHaveBeenCalled();
    expect(currentError).not.toHaveBeenCalledWith(strings.error);
    expect(currentFailure).not.toHaveBeenCalled();
  });
});

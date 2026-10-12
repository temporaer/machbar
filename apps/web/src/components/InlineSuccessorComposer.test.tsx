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

  it("preserves a dated successor while collecting activation requirements and retries the same operation", async () => {
    mockedApi.getMembers.mockResolvedValue([{ id: 1, name: "Mira" } as never]);
    mockedApi.createTaskSuccessor
      .mockRejectedValueOnce(Object.assign(new Error("Projekt braucht eine verantwortliche Person"), {
        code: "project_commitment_resolution_required",
        details: {
          projects: [{ projectId: 12, title: "Sommerfest", revision: 5, ownerMemberId: null, required: ["driver"] }],
          expectedProjects: [{ projectId: 12, revision: 5 }],
          targetRevision: 5,
        },
      }))
      .mockResolvedValueOnce(makeTask({ id: 2, title: "Rechnung bezahlen" }));
    const onCreated = vi.fn();
    renderWithProviders(
      <InlineSuccessorComposer predecessorId={1} onCancel={vi.fn()} onCreated={onCreated} />,
    );

    const title = screen.getByPlaceholderText("Nächster Schritt");
    await userEvent.type(title, "Angebot vergleichen");
    await userEvent.click(screen.getByText("Planung (optional)"));
    await userEvent.type(screen.getByLabelText("Geplant für"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    const driver = await screen.findByLabelText("Verantwortlich für „Sommerfest“");
    expect(title).toHaveValue("Angebot vergleichen");
    expect(screen.getByLabelText("Geplant für")).toHaveValue("2027-03-12");
    await userEvent.selectOptions(driver, "1");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.createTaskSuccessor).toHaveBeenCalledTimes(2));
    expect(mockedApi.createTaskSuccessor).toHaveBeenLastCalledWith(1, {
      title: "Angebot vergleichen",
      scheduledDate: "2027-03-12",
      createdByMemberId: null,
      status: "actionable",
      activationResolution: {
        expectedProjects: [{ projectId: 12, revision: 5 }],
        drivers: [{ projectId: 12, ownerMemberId: 1 }],
      },
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("does not retry a dated successor when the user cancels activation decisions", async () => {
    mockedApi.createTaskSuccessor.mockRejectedValueOnce(Object.assign(new Error("Treiber fehlt"), {
      code: "project_commitment_resolution_required",
      details: {
        projects: [{ projectId: 12, title: "Sommerfest", revision: 5, ownerMemberId: null, required: ["driver"] }],
        expectedProjects: [{ projectId: 12, revision: 5 }],
      },
    }));
    const onCancel = vi.fn();
    const onCreated = vi.fn();
    renderWithProviders(<InlineSuccessorComposer predecessorId={1} onCancel={onCancel} onCreated={onCreated} />);
    await userEvent.type(screen.getByPlaceholderText("Nächster Schritt"), "Angebot vergleichen");
    await userEvent.click(screen.getByText("Planung (optional)"));
    await userEvent.type(screen.getByLabelText("Geplant für"), "2027-03-12");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByLabelText("Verantwortlich für „Sommerfest“")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
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

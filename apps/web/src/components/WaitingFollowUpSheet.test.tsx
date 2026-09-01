import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    followUpExternalWait: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingFollowUpSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("sends authored content and the wait's revisit date in one continue command", async () => {
    const task = makeTask({
      id: 9,
      notes: "Erste Anfrage.",
      revision: 3,
      externalWait: {
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
      },
      scheduledDate: "2026-09-10",
      nextBlockerAttentionDate: "2026-08-31",
      blocked: true,
      executable: false,
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 4,
    });
    const onClose = vi.fn();
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={onClose} />,
    );

    const content = await screen.findByLabelText("Notizen");
    expect(content).toHaveValue("");
    await userEvent.type(content, "Erneut angerufen.");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(9, {
        action: "continue",
        content: "Erneut angerufen.",
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
        expectedRevision: 3,
      }),
    );
    expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resolves the wait together with the newly authored follow-up", async () => {
    const task = makeTask({
      id: 10,
      notes: "Erste Anfrage.",
      revision: 7,
      externalWait: {
        waitingFor: "Vermieter",
        revisitDate: "2026-09-05",
      },
      scheduledDate: "2026-09-05",
    });
    mockedApi.followUpExternalWait.mockResolvedValue({
      ...task,
      revision: 8,
      externalWait: null,
    });
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={vi.fn()} />,
    );

    await userEvent.type(
      await screen.findByLabelText("Notizen"),
      "Antwort erhalten.",
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Warten beenden" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledWith(10, {
        action: "resolve",
        content: "Antwort erhalten.",
        expectedRevision: 7,
      }),
    );
    expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1);
  });

  it("retains the draft and error after a failed atomic save", async () => {
    const task = makeTask({
      id: 11,
      revision: 2,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    });
    mockedApi.followUpExternalWait.mockRejectedValue(new Error("Save failed"));
    const onClose = vi.fn();
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={onClose} />,
    );

    const content = await screen.findByLabelText("Notizen");
    await userEvent.type(content, "Mein Entwurf");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(content).toHaveValue("Mein Entwurf");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers explicit Save and Cancel actions and blocks every close path while pending", async () => {
    const task = makeTask({
      id: 12,
      revision: 4,
      externalWait: { waitingFor: "Amt", revisitDate: null },
    });
    let resolveRequest!: (task: ReturnType<typeof makeTask>) => void;
    mockedApi.followUpExternalWait.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const onClose = vi.fn();
    renderWithProviders(
      <WaitingFollowUpSheet task={task} onClose={onClose} />,
    );

    const save = screen.getByRole("button", { name: "Speichern" });
    const cancel = screen.getByRole("button", { name: "Abbrechen" });
    expect(save).toBeDisabled();
    await userEvent.type(await screen.findByLabelText("Notizen"), "Nachfrage");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() =>
      expect(mockedApi.followUpExternalWait).toHaveBeenCalledTimes(1),
    );
    expect(cancel).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    resolveRequest({ ...task, revision: 5 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { followUpEntryHeader } from "./WaitingFollowUpSheet";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateTask: vi.fn(),
    setExternalWait: vi.fn(),
    resolveExternalWait: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("followUpEntryHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("serializes the generated follow-up timestamp in the selected locale", () => {
    const now = new Date(2026, 7, 27, 18, 5);
    const timestamp = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(now);

    expect(followUpEntryHeader("Mira", now, "en")).toBe(
      `[${timestamp} · Mira]`,
    );
  });

  it("appends a timestamped note and resolves the external wait without a status mutation", async () => {
    const task = makeTask({
      id: 9,
      notes: "Erste Anfrage.",
      revision: 3,
      externalWait: { waitingFor: "Vermieter" },
      scheduledDate: "2026-09-05",
      nextBlockerAttentionDate: "2026-09-05",
      blocked: true,
      executable: false,
    });
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 4 });
    mockedApi.resolveExternalWait.mockResolvedValue({
      ...task,
      revision: 5,
      externalWait: null,
      scheduledDate: null,
      nextBlockerAttentionDate: null,
    });
    renderWithProviders(<WaitingFollowUpSheet task={task} onClose={vi.fn()} />);

    const notes = await screen.findByLabelText("Notizen");
    expect((notes as HTMLTextAreaElement).value).toMatch(/\[[^\]]+ · [^\]]+\]/);
    await userEvent.type(notes, "Erneut angerufen.");
    await userEvent.click(screen.getByRole("checkbox", { name: "Wartepunkt auflösen" }));
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.resolveExternalWait).toHaveBeenCalledWith(9, 4),
    );
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
  });
});

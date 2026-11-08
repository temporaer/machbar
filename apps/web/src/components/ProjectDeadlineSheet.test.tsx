import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import { ApiError } from "../lib/api";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { RefreshProvider } from "../lib/refresh";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/projectQueries";

vi.mock("../lib/identity", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/identity")>(),
  useIdentity: () => ({ members: [{ id: 1, name: "Mira" }, { id: 2, name: "Sarah" }] }),
}));

function Actions({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient()}><RefreshProvider><ProjectActionsProvider>{children}</ProjectActionsProvider></RefreshProvider></QueryClientProvider>;
}

describe("ProjectDeadlineSheet", () => {
  it("rejects an invalid date, saves valid input, and closes explicitly", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectDeadlineSheet
        story={makeProject({ id: 1, title: "Urlaub" })}
        onClose={onClose}
        onSave={onSave}
      />, { wrapper: Actions },
    );

    expect(
      screen.getByRole("heading", { name: "Projekt-Deadline" }),
    ).toBeInTheDocument();
    const dueDate = screen.getByLabelText("Fällig");
    await userEvent.type(dueDate, "irgendwann vielleicht");

    fireEvent.blur(dueDate);
    expect(screen.getByRole("alert")).toHaveTextContent("Datum nicht erkannt");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();

    await userEvent.clear(dueDate);
    await userEvent.type(dueDate, "2026-09-10{Enter}");

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ dueDate: "2026-09-10" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Schließen" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("refreshes project decisions and retries the unchanged deadline draft after a stale revision", async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(
        409,
        "The project changed while planning.",
        "project_commitment_resolution_required",
        {
          reason: "project_snapshot_stale",
          targetRevision: 5,
          projects: [{
            projectId: 1,
            title: "Urlaub",
            revision: 5,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 1, revision: 5 }],
        },
      ))
      .mockResolvedValueOnce(undefined);
    render(
      <ProjectDeadlineSheet
        story={makeProject({ id: 1, title: "Urlaub", status: "backlog", revision: 4 })}
        onClose={vi.fn()}
        onSave={onSave}
      />, { wrapper: Actions },
    );

    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Verantwortlich für „Urlaub“")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Verantwortlich für „Urlaub“"), "2");
    await userEvent.type(
      screen.getByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?"),
      "Hotels vergleichen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({
      dueDate: "2026-12-15",
      expectedRevision: 5,
      activationResolution: {
        expectedProjects: [{ projectId: 1, revision: 5 }],
        drivers: [{ projectId: 1, ownerMemberId: 2 }],
        nextActionTitle: "Hotels vergleichen",
      },
    });
  });

});

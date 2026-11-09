import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import { api, ApiError } from "../lib/api";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";

vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ members: [{ id: 1, name: "Mira" }, { id: 2, name: "Sarah" }] }),
}));

describe("ProjectDeadlineSheet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an invalid date, saves valid input, and closes explicitly", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectDeadlineSheet
        story={makeProject({ id: 1, title: "Urlaub" })}
        onClose={onClose}
        onSave={onSave}
      />,
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

  describe("requirements reload recovery", () => {
    it("also recovers an unchanged deadline after an ordinary write outage without replay", async () => {
      const onSave = vi.fn().mockRejectedValueOnce(new ApiError(503, "Offline", "internal_error")).mockResolvedValue(undefined);
      const read = vi.spyOn(api, "getProject").mockResolvedValue({
        ...makeProject({ id: 1, title: "Urlaub", revision: 6 }), tasks: [],
      });
      render(<ProjectDeadlineSheet story={makeProject({ id: 1, title: "Urlaub", revision: 4 })} onClose={vi.fn()} onSave={onSave} />);
      await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
      const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
      expect(read).not.toHaveBeenCalled();
      await userEvent.click(retry);
      await screen.findByRole("button", { name: "Speichern" });
      expect(onSave).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
      expect(onSave).toHaveBeenLastCalledWith({
        dueDate: "2026-12-15", expectedRevision: 6,
        activationResolution: { expectedProjects: [], drivers: [] },
      });
    });

    it.each([
      new TypeError("Failed to fetch"),
      new ApiError(503, "Unavailable", "internal_error"),
    ])("can reload requirements after stale save recovery fails: %s", async readFailure => {
      const onSave = vi.fn()
        .mockRejectedValueOnce(new ApiError(409, "Decisions needed", "project_commitment_resolution_required", {
          targetRevision: 5,
          projects: [{ projectId: 1, title: "Urlaub", revision: 5, ownerMemberId: null, required: ["driver", "progressPath"] }],
          expectedProjects: [{ projectId: 1, revision: 5 }],
        }))
        .mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict"))
        .mockResolvedValue(undefined);
      const read = vi.spyOn(api, "getProject").mockRejectedValueOnce(readFailure).mockResolvedValue({
        ...makeProject({ id: 1, title: "Urlaub", status: "backlog", revision: 6 }),
        tasks: [],
        activationDecisionSnapshot: {
          targetRevision: 6,
          projects: [{ projectId: 1, title: "Urlaub", revision: 6, ownerMemberId: null, required: ["driver", "progressPath"] }],
          expectedProjects: [{ projectId: 1, revision: 6 }],
        },
      });
      render(<ProjectDeadlineSheet story={makeProject({ id: 1, title: "Urlaub", revision: 4 })} onClose={vi.fn()} onSave={onSave} />);
      const date = screen.getByLabelText<HTMLInputElement>("Fällig");
      await userEvent.type(date, "2026-12-15{Enter}");
      await screen.findByLabelText("Verantwortlich für „Urlaub“");
      const selectedDate = date.value;
      await userEvent.selectOptions(screen.getByLabelText("Verantwortlich für „Urlaub“"), "2");
      await userEvent.type(screen.getByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?"), "Old decision");
      await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

      const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
      expect(date).toHaveValue(selectedDate);
      expect(screen.queryByLabelText("Verantwortlich für „Urlaub“")).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledTimes(2);
      await userEvent.click(retry);
      expect(await screen.findByLabelText("Verantwortlich für „Urlaub“")).toHaveValue("");
      expect(screen.getByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?")).toHaveValue("");
      expect(read).toHaveBeenCalledTimes(2);
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(date).toHaveValue(selectedDate);
      expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
      await userEvent.selectOptions(screen.getByLabelText("Verantwortlich für „Urlaub“"), "1");
      await userEvent.type(screen.getByLabelText("Welcher konkrete nächste Schritt bringt das Projekt voran?"), "Fresh decision");
      await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
      expect(onSave).toHaveBeenLastCalledWith({
        dueDate: "2026-12-15",
        expectedRevision: 6,
        activationResolution: {
          expectedProjects: [{ projectId: 1, revision: 6 }],
          drivers: [{ projectId: 1, ownerMemberId: 1 }],
          nextActionTitle: "Fresh decision",
        },
      });
    });

    it("keeps GET-only retry after another outage and allows reconfirmation when no activation is needed", async () => {
      const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
      const read = vi.spyOn(api, "getProject")
        .mockRejectedValueOnce(new TypeError("Offline"))
        .mockRejectedValueOnce(new TypeError("Still offline"))
        .mockResolvedValue({ ...makeProject({ id: 1, title: "Urlaub", revision: 6 }), tasks: [] });
      render(<ProjectDeadlineSheet story={makeProject({ id: 1, title: "Urlaub", revision: 4 })} onClose={vi.fn()} onSave={onSave} />);
      await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
      await userEvent.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled());
      expect(onSave).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
      const save = await screen.findByRole("button", { name: "Speichern" });
      expect(onSave).toHaveBeenCalledTimes(1);
      await userEvent.click(save);
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
      expect(onSave).toHaveBeenLastCalledWith({
        dueDate: "2026-12-15", expectedRevision: 6,
        activationResolution: { expectedProjects: [], drivers: [] },
      });
    });
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
      />,
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

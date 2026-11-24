import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import { ApiError } from "../lib/api";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";

describe("ProjectDeadlineSheet", () => {
  it("saves a deadline directly without activation decisions", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectDeadlineSheet story={makeProject({ id: 1, title: "Urlaub", status: "backlog" })} onClose={vi.fn()} onSave={onSave} />);
    const date = screen.getByLabelText("Fällig");
    await userEvent.type(date, "irgendwann vielleicht");
    fireEvent.blur(date);
    expect(screen.getByRole("alert")).toHaveTextContent("Datum nicht erkannt");
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.clear(date);
    await userEvent.type(date, "2026-09-10{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ dueDate: "2026-09-10" }));
    expect(screen.queryByLabelText(/Verantwortlich für/)).not.toBeInTheDocument();
  });

  it("retains the date and requests refresh after stale write, then retries explicitly", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const onRefresh = vi.fn();
    const story = makeProject({ id: 1, title: "Urlaub", revision: 1 });
    const onClose = vi.fn();
    const view = render(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(retry).toBeDisabled();
    view.rerender(<ProjectDeadlineSheet story={{ ...story, revision: 2 }} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });

  it("retains a deadline after an ordinary outage without an automatic second write", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(503, "Offline")).mockResolvedValue(undefined);
    const onRefresh = vi.fn();
    render(<ProjectDeadlineSheet story={makeProject({ id: 1 })} onClose={vi.fn()} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });

  it("retains a deadline after stale and failed refresh, retrying the read before the write", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const onRefresh = vi.fn();
    const story = makeProject({ id: 1, revision: 1 });
    const onClose = vi.fn();
    const view = render(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    await screen.findByRole("button", { name: "Erneut versuchen" });
    view.rerender(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} refreshError="Offline" />);
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenCalledTimes(1);
    view.rerender(<ProjectDeadlineSheet story={{ ...story, revision: 2 }} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });
});

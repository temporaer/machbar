import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import { PlanDatesSheet } from "./PlanDatesSheet";

describe("PlanDatesSheet", () => {
  it("rejects an invalid date, then saves a valid selection immediately", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PlanDatesSheet
        story={makeProject({ id: 1, title: "Urlaub" })}
        onClose={onClose}
        onSave={onSave}
      />,
    );

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
    expect(onClose).toHaveBeenCalled();
  });
});

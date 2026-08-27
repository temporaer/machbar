import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fixtures";
import { PlanDatesSheet } from "./PlanDatesSheet";

describe("PlanDatesSheet", () => {
  it("does not save or close while a date is invalid", async () => {
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

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.blur(dueDate);
    expect(screen.getByRole("alert")).toHaveTextContent("Datum nicht erkannt");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeCriterion, makeTask } from "../test/fixtures";
import { LocaleProvider } from "../lib/locale";
import { CompleteWithCriteriaSheet } from "./CompleteWithCriteriaSheet";

describe("CompleteWithCriteriaSheet", () => {
  it("keeps criterion checks local until completion and preserves them when completion conflicts", async () => {
    const task = makeTask({ acceptanceCriteria: [makeCriterion({ id: 12, text: "Test bestanden" })] });
    const onComplete = vi.fn().mockRejectedValueOnce(new Error("stale revision")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<LocaleProvider initialLocale="de"><CompleteWithCriteriaSheet workItem={task} workItemType="task" onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    const checkbox = screen.getByRole("checkbox", { name: "Test bestanden" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(onComplete).not.toHaveBeenCalled();
    expect(task.acceptanceCriteria[0]?.checked).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Aufgabe abschließen" }));
    expect(onComplete).toHaveBeenCalledWith([12]);
    expect(onClose).not.toHaveBeenCalled();
    expect(checkbox).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Aufgabe abschließen" }));
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not persist decisions when the user closes the sheet", async () => {
    const task = makeTask({ acceptanceCriteria: [makeCriterion({ id: 13, text: "Freigabe erhalten" })] });
    const onComplete = vi.fn();
    const onClose = vi.fn();
    render(<LocaleProvider initialLocale="de"><CompleteWithCriteriaSheet workItem={task} workItemType="task" onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    await userEvent.click(screen.getByRole("checkbox", { name: "Freigabe erhalten" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Schließen" }).at(-1)!);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

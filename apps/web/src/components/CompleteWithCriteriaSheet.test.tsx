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
    expect(onComplete).toHaveBeenCalledWith([12], undefined);
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

  it("requires the open-child policy with criterion checks and commits both together", async () => {
    const task = makeTask({
      acceptanceCriteria: [makeCriterion({ id: 14, text: "Abnahme erfolgt" })],
      children: [makeTask({ id: 40, title: "Teilaufgabe", status: "actionable", children: [] })],
    });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<LocaleProvider initialLocale="de"><CompleteWithCriteriaSheet workItem={task} workItemType="task" onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    const complete = screen.getByRole("button", { name: "Aufgabe abschließen" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Abnahme erfolgt" }));
    expect(complete).toBeDisabled();
    expect(onComplete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: /Teilaufgaben ebenfalls erledigen/ }));
    expect(complete).toBeEnabled();
    expect(onComplete).not.toHaveBeenCalled();
    await userEvent.click(complete);
    expect(onComplete).toHaveBeenCalledWith([14], "complete_children");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps both completion decisions local when cancelled", async () => {
    const task = makeTask({
      acceptanceCriteria: [makeCriterion({ id: 15, text: "Ergebnis geprüft" })],
      children: [makeTask({ id: 41, title: "Offene Teilaufgabe", status: "actionable", children: [] })],
    });
    const onComplete = vi.fn();
    const onClose = vi.fn();
    render(<LocaleProvider initialLocale="de"><CompleteWithCriteriaSheet workItem={task} workItemType="task" onClose={onClose} onComplete={onComplete} /></LocaleProvider>);
    await userEvent.click(screen.getByRole("checkbox", { name: "Ergebnis geprüft" }));
    await userEvent.click(screen.getByRole("radio", { name: /Teilaufgaben offen lassen/ }));
    await userEvent.click(screen.getAllByRole("button", { name: "Schließen" }).at(-1)!);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

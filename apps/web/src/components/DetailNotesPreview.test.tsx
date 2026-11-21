import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailNotesPreview } from "./DetailNotesPreview";

describe("detail checklist focus", () => {
  const before = "- [ ] Item";
  const after = "- [x] Item";

  it("restores focus after a successful write when the same input survives", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    expect(toggle).toHaveBeenCalledWith(after);
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    input.blur();
    rerender(<DetailNotesPreview value={after} onChecklistToggle={toggle} />);
    expect(input).toHaveFocus();
  });

  it("does not restore focus after the user focuses another control", () => {
    const toggle = vi.fn();
    const renderPreview = (value: string, disabled: boolean) => <>
      <button>Elsewhere</button>
      <DetailNotesPreview value={value} onChecklistToggle={toggle} checklistDisabled={disabled} />
    </>;
    const { rerender } = render(renderPreview(before, false));
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    rerender(renderPreview(before, true));
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    rerender(renderPreview(after, false));
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("keeps the user's new checklist focus when the pending toggle succeeds", () => {
    const value = "- [ ] First\n- [ ] Second";
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={value} onChecklistToggle={toggle} />);
    const first = screen.getByRole("checkbox", { name: "First" });
    first.focus();
    fireEvent.click(first);
    rerender(<DetailNotesPreview value={value} onChecklistToggle={toggle} checklistDisabled />);
    const second = screen.getByRole("checkbox", { name: "Second" });
    second.focus();
    rerender(<DetailNotesPreview value={"- [x] First\n- [ ] Second"} onChecklistToggle={toggle} />);
    expect(second).toHaveFocus();
  });

  it("does not focus a disconnected input or a replacement after a refresh", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    input.remove();
    rerender(<DetailNotesPreview value={after} onChecklistToggle={toggle} />);
    expect(input.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(input);
    expect(document.body).toHaveFocus();
  });

  it("does not retain focus on a different item after a conflict refresh", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    rerender(<DetailNotesPreview value={"- [ ] Other\n- [ ] Item"} onChecklistToggle={toggle} />);
    expect(screen.getByRole("checkbox", { name: "Other" })).not.toHaveFocus();
  });

  it("does not leave focus on a recycled checkbox after moving during a stale write", () => {
    const value = "- [ ] First\n- [ ] Second";
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={value} onChecklistToggle={toggle} />);
    const first = screen.getByRole("checkbox", { name: "First" });
    first.focus();
    fireEvent.click(first);
    rerender(<DetailNotesPreview value={value} onChecklistToggle={toggle} checklistDisabled />);
    screen.getByRole("checkbox", { name: "Second" }).focus();
    rerender(<DetailNotesPreview value={"- [ ] Inserted\n" + value} onChecklistToggle={toggle} />);
    expect(screen.getByRole("checkbox", { name: "First" })).not.toHaveFocus();
  });

  it("does not retain focus when an indistinguishable duplicate is inserted", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    screen.getByRole("checkbox").focus();
    rerender(<DetailNotesPreview value={`${before}\n${before}`} onChecklistToggle={toggle} />);
    expect(screen.getAllByRole("checkbox")[0]).not.toHaveFocus();
  });

  it("restores focus after a failed write and retires it when notes change", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    input.blur();
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    expect(input).toHaveFocus();
    rerender(<DetailNotesPreview value={before + "\n\nNew context"} onChecklistToggle={toggle} />);
    expect(input).not.toHaveFocus();
  });

  it("does not restore focus when a failed refresh leaves the preview unavailable", () => {
    const toggle = vi.fn();
    const { rerender } = render(<DetailNotesPreview value={before} onChecklistToggle={toggle} />);
    const input = screen.getByRole("checkbox");
    input.focus();
    fireEvent.click(input);
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    input.blur();
    rerender(<DetailNotesPreview value={before} onChecklistToggle={toggle} checklistDisabled />);
    expect(input).not.toHaveFocus();
  });
});

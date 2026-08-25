import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagChip } from "./TagChip";
import { makeTag } from "../test/fixtures";

describe("TagChip", () => {
  it("ruft onRemove auf, wenn das Kreuz geklickt wird", async () => {
    const onRemove = vi.fn();
    render(<TagChip tag={makeTag({ name: "büro" })} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("zeigt einen ausgeschlossenen geerbten Tag durchgestrichen an", () => {
    render(<TagChip tag={makeTag({ name: "eilig" })} excluded onToggleExclude={vi.fn()} />);
    expect(screen.getByText("eilig").closest("span")).toHaveClass("chip-muted");
    expect(screen.getByRole("button", { name: "Ausschluss aufheben" })).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefinementMatrix } from "./RefinementMatrix";
import type { RefinementMatrixSelection } from "./RefinementMatrix";
import type { OwnerSizeCounts } from "../lib/api";

function makeRow(overrides: Partial<OwnerSizeCounts> = {}): OwnerSizeCounts {
  return {
    ownerId: 1,
    ownerName: "Mira",
    S: 0,
    M: 0,
    L: 0,
    XL: 0,
    unestimated: 0,
    total: 0,
    ...overrides,
  };
}

describe("RefinementMatrix", () => {
  it("renders every owner row including the trailing shared/unassigned ('Gemeinsam / offen') row", () => {
    const rows = [
      makeRow({ ownerId: 1, ownerName: "Mira", M: 2, total: 2 }),
      makeRow({ ownerId: 2, ownerName: "Alex", S: 1, total: 1 }),
      makeRow({ ownerId: null, ownerName: null, unestimated: 3, total: 3 }),
    ];
    render(<RefinementMatrix rows={rows} selection={null} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Mira" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gemeinsam / offen" })).toBeInTheDocument();
  });

  it("clicking a size cell selects that owner+size and marks it pressed", async () => {
    const rows = [makeRow({ ownerId: 1, ownerName: "Mira", M: 2, total: 2 })];
    const onSelect = vi.fn();
    const { rerender } = render(<RefinementMatrix rows={rows} selection={null} onSelect={onSelect} />);

    const cells = screen.getAllByRole("button", { name: "2" });
    await userEvent.click(cells[0]!);

    expect(onSelect).toHaveBeenCalledWith({ ownerId: 1, size: "M" });

    rerender(<RefinementMatrix rows={rows} selection={{ ownerId: 1, size: "M" }} onSelect={onSelect} />);
    expect(screen.getAllByRole("button", { name: "2" })[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking the same selection again clears it (toggle off)", async () => {
    const rows = [makeRow({ ownerId: 1, ownerName: "Mira" })];
    const onSelect = vi.fn();
    render(<RefinementMatrix rows={rows} selection={{ ownerId: 1 }} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "Mira" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("clicking an owner's row header selects that owner across all sizes", async () => {
    const rows = [makeRow({ ownerId: 2, ownerName: "Alex" })];
    const onSelect = vi.fn();
    render(<RefinementMatrix rows={rows} selection={null} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "Alex" }));
    expect(onSelect).toHaveBeenCalledWith({ ownerId: 2 } as RefinementMatrixSelection);
  });
});

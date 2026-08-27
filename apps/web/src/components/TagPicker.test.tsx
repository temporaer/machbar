import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagPicker } from "./TagPicker";
import { makeTag } from "../test/fixtures";

describe("TagPicker", () => {
  it("zeigt alle Tags als kompakte, direkt antippbare Auswahl", async () => {
    const onChange = vi.fn();
    render(
      <TagPicker
        tags={[
          makeTag({ id: 1, name: "Lars", color: "#2563eb" }),
          makeTag({ id: 2, name: "Garten", color: "#16a34a" }),
        ]}
        selectedIds={[1]}
        onChange={onChange}
      />,
    );

    const lars = screen.getByRole("button", { name: "Lars" });
    expect(lars).toHaveClass("tag-choice");
    expect(lars).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Garten" }));
    expect(onChange).toHaveBeenCalledWith([1, 2]);
  });

  it("offers only existing tags and no inline creation controls", () => {
    render(<TagPicker tags={[]} selectedIds={[]} onChange={vi.fn()} />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anlegen" })).not.toBeInTheDocument();
  });
});

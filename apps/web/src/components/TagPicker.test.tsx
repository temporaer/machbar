import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagPicker } from "./TagPicker";
import { makeTag } from "../test/fixtures";

describe("TagPicker", () => {
  it("shows only non-empty tag groups, expanded by default", async () => {
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

    const heading = screen.getByRole("heading", { name: "Normal (2)" });
    expect(heading.closest("details")).toHaveAttribute("open");
    expect(screen.queryByRole("heading", { name: /^Bereich/ })).not.toBeInTheDocument();

    const lars = screen.getByRole("button", { name: "Lars" });
    expect(lars).toBeVisible();
    expect(lars).toHaveClass("tag-choice");
    expect(lars).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Garten" }));
    expect(onChange).toHaveBeenCalledWith([1, 2]);

    // Still collapsible: a click on the summary hides it again.
    await userEvent.click(heading.closest("summary")!);
    expect(screen.getByRole("button", { name: "Lars" })).not.toBeVisible();
  });

  it("offers only existing tags and no inline creation controls", () => {
    render(<TagPicker tags={[]} selectedIds={[]} onChange={vi.fn()} />);

    expect(screen.getByText("Keine Tags.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anlegen" })).not.toBeInTheDocument();
  });
});

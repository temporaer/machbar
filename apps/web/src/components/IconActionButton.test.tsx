import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconActionButton, IconActionGlyph } from "./IconActionButton";
import "../styles/index.css";

describe("IconActionButton", () => {
  it("provides the shared 44px, labelled icon control used by task and project actions", async () => {
    const onClick = vi.fn();
    render(<IconActionButton kind="owner" label="Verantwortlich" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Verantwortlich" });
    expect(button).toHaveClass("icon-action-button");
    expect(button).toHaveAttribute("title", "Verantwortlich");
    expect(getComputedStyle(button).width).toBe("44px");
    expect(getComputedStyle(button).height).toBe("44px");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector("svg")).toHaveAttribute("focusable", "false");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("uses a reversible arrow, not delete iconography, for discard", () => {
    const { container } = render(<IconActionGlyph kind="discard" />);

    expect(container.querySelector("path[d='M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13']")).not.toBeInTheDocument();
    expect(container.querySelector("path[d='M19.5 10a7.5 7.5 0 10.2 3.5']")).toBeInTheDocument();
  });
});

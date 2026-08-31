import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("portals the overlay outside transformed or clipped ancestors", () => {
    const { container } = render(
      <div className="task-row">
        <BottomSheet title="Details" onClose={vi.fn()}>
          Inhalt
        </BottomSheet>
      </div>,
    );

    expect(container.querySelector(".sheet-backdrop")).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Details" }).closest(".sheet-backdrop")
        ?.parentElement,
    ).toBe(document.body);
  });

  it("renders header actions beside a thumb-sized close action and compact status", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        title="Details"
        labelledBy="details-title"
        onClose={onClose}
        headerActions={<button type="button">Teilen</button>}
        headerStatus={<span role="status">Geteilt</span>}
      >
        Inhalt
      </BottomSheet>,
    );

    const header = screen
      .getByRole("heading", { name: "Details" })
      .closest<HTMLElement>(".sheet-header");
    expect(header).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Details" })).toHaveAttribute(
      "aria-labelledby",
      "details-title",
    );
    expect(within(header!).getByRole("button", { name: "Teilen" })).toBeInTheDocument();
    const close = within(header!).getByRole("button", { name: "Schließen" });
    expect(close).toHaveClass("icon-action-button");
    expect(screen.getByRole("status")).toHaveTextContent("Geteilt");

    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("focuses the first control, traps focus, and restores the opener", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <BottomSheet onClose={vi.fn()}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </BottomSheet>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("restores focus after a close control removes itself during its click", async () => {
    const user = userEvent.setup();

    function SheetTrigger() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open ? (
            <BottomSheet title="Details" onClose={() => setOpen(false)}>
              <input aria-label="Details" autoFocus />
            </BottomSheet>
          ) : null}
        </>
      );
    }

    render(<SheetTrigger />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(screen.getByRole("textbox", { name: "Details" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Schließen" }));

    expect(opener).toHaveFocus();
  });

  it("focuses the dialog itself when it has no focusable content", () => {
    render(<BottomSheet onClose={vi.fn()}>Plain content</BottomSheet>);

    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAttribute("tabindex", "-1");
  });

  it("traps focus on a closed disclosure summary and skips its hidden controls", async () => {
    const user = userEvent.setup();
    render(
      <BottomSheet onClose={vi.fn()}>
        <button type="button">First</button>
        <details>
          <summary>More options</summary>
          <button type="button">Hidden action</button>
        </details>
      </BottomSheet>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const summary = screen.getByText("More options");
    expect(first).toHaveFocus();

    await user.tab();
    expect(summary).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it("preserves a content control's intentional autofocus", () => {
    render(
      <BottomSheet title="Create" onClose={vi.fn()}>
        <input aria-label="Title" autoFocus />
      </BottomSheet>,
    );

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveFocus();
  });

  it("makes the app inert and locks scrolling until the last sheet is removed", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.setAttribute("aria-hidden", "false");
    document.body.append(root);
    document.body.style.overflow = "clip";

    const { unmount } = render(
      <BottomSheet title="Details" onClose={vi.fn()}>
        Content
      </BottomSheet>,
      { container: root },
    );

    expect(root).toHaveAttribute("inert");
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(root).not.toHaveAttribute("inert");
    expect(root).toHaveAttribute("aria-hidden", "false");
    expect(document.body.style.overflow).toBe("clip");

    document.body.style.overflow = "";
    root.remove();
  });

  it("hides underlying sheets and lets only the topmost sheet handle Escape", () => {
    const bottomClose = vi.fn();

    function NestedSheets() {
      const [showTop, setShowTop] = useState(true);
      return (
        <>
          <BottomSheet title="Bottom" onClose={bottomClose} labelledBy="bottom-title">
            Bottom content
          </BottomSheet>
          {showTop ? (
            <BottomSheet
              title="Top"
              onClose={() => setShowTop(false)}
              labelledBy="top-title"
            >
              Top content
            </BottomSheet>
          ) : null}
        </>
      );
    }

    render(<NestedSheets />);

    const dialogs = document.querySelectorAll<HTMLElement>(".sheet");
    const backdrops = document.querySelectorAll<HTMLElement>(".sheet-backdrop");
    expect(dialogs[0]).toHaveAttribute("inert");
    expect(dialogs[0]).toHaveAttribute("aria-hidden", "true");
    expect(backdrops[0]).toHaveAttribute("inert");
    expect(dialogs[1]).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Top" })).not.toBeInTheDocument();
    expect(bottomClose).not.toHaveBeenCalled();
    expect(dialogs[0]).not.toHaveAttribute("inert");
    expect(dialogs[0]).not.toHaveAttribute("aria-hidden");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(bottomClose).toHaveBeenCalledOnce();
  });

  it("restores the original opener when nested sheets unmount together", async () => {
    const user = userEvent.setup();

    function NestedSheetTrigger() {
      const [showDetails, setShowDetails] = useState(false);
      const [showConfirmation, setShowConfirmation] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setShowDetails(true)}>Open details</button>
          {showDetails ? (
            <BottomSheet title="Details" onClose={() => setShowDetails(false)}>
              <button type="button" onClick={() => setShowConfirmation(true)}>
                Open confirmation
              </button>
            </BottomSheet>
          ) : null}
          {showConfirmation ? (
            <BottomSheet title="Confirmation" onClose={() => setShowConfirmation(false)}>
              <button
                type="button"
                onClick={() => {
                  setShowDetails(false);
                  setShowConfirmation(false);
                }}
              >
                Close all
              </button>
            </BottomSheet>
          ) : null}
        </>
      );
    }

    render(<NestedSheetTrigger />);
    const opener = screen.getByRole("button", { name: "Open details" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    await user.click(screen.getByRole("button", { name: "Close all" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("does not leak stack state or page attributes through StrictMode cleanup", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const onClose = vi.fn();

    const { unmount } = render(
      <StrictMode>
        <BottomSheet onClose={onClose}>Content</BottomSheet>
      </StrictMode>,
      { container: root },
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(root).not.toHaveAttribute("inert");
    expect(root).not.toHaveAttribute("aria-hidden");
    expect(document.body.style.overflow).toBe("");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    root.remove();
  });
});

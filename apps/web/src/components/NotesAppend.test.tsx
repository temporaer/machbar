import { markdownValue, setMarkdownValue } from "../test/markdownEditor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/identity", () => ({
  useIdentity: () => ({ currentMember: { name: "Hannes" } }),
}));
import { NotesAppend } from "./NotesAppend";
import { MarkdownNotes } from "./MarkdownNotes";
import { NotesTail } from "./NotesTail";

it("keeps an append draft after failure and retries without replacing existing notes", async () => {
  const append = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ notes: "Background\n\nOutcome" });
  render(
    <>
      <MarkdownNotes value="Background" />
      <NotesAppend onAppend={append} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notiz hinzufügen" }));
  setMarkdownValue(screen.getByRole("textbox"), "Outcome");
  fireEvent.click(screen.getByRole("button", { name: "Notiz hinzufügen" }));
  await screen.findByRole("alert");
  expect(markdownValue(screen.getByRole("textbox"))).toBe("Outcome");
  expect(screen.getByText("Background")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Notiz hinzufügen" }));
  await waitFor(() =>
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
  );
  expect(append).toHaveBeenCalledTimes(2);
  expect(append.mock.calls[0]![0]).toMatch(/^\[.*Z · .*\]\nOutcome$/);
});

it("does not discard an append draft when full-document editing disables it", () => {
  const append = vi.fn();
  const { rerender } = render(<NotesAppend onAppend={append} />);
  fireEvent.click(screen.getByRole("button", { name: "Notiz hinzufügen" }));
  setMarkdownValue(screen.getByRole("textbox"), "Draft");
  rerender(<NotesAppend onAppend={append} disabled />);
  expect(markdownValue(screen.getByRole("textbox"))).toBe("Draft");
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-disabled", "true");
});

it("shows the end of long notes and keeps links independent from detail navigation", () => {
  const open = vi.fn();
  render(
    <NotesTail
      value={"Old ".repeat(200) + "[Latest](https://example.com)"}
      onOpen={open}
    />,
  );
  const link = screen.getByRole("link", { name: "Latest" });
  fireEvent.click(link);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Notizen öffnen" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.getByText(/…/)).toBeInTheDocument();
});

it("renders existing timestamp metadata with its full instant and no orphan for ordinary prose", () => {
  const { container } = render(
    <MarkdownNotes
      value={"Background\n\n[2026-10-19T15:21:00Z · Hannes]\n**Outcome**"}
    />,
  );
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-10-19T15:21:00Z",
  );
  expect(screen.getByText("Outcome")).toBeInTheDocument();
  expect(screen.getByText("Background")).toBeInTheDocument();
});

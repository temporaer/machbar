import { createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  applyMarkdownToolbarAction,
  MarkdownEditor,
  type MarkdownToolbarAction,
} from "./MarkdownEditor";

describe("applyMarkdownToolbarAction", () => {
  it.each<
    [MarkdownToolbarAction, string, number, number, { value: string; selectionStart: number; selectionEnd: number }]
  >([
    ["bullet", "one\ntwo", 0, 7, { value: "- one\n- two", selectionStart: 2, selectionEnd: 11 }],
    ["checkbox", "item", 0, 4, { value: "- [ ] item", selectionStart: 6, selectionEnd: 10 }],
    ["bold", "note", 1, 3, { value: "n**ot**e", selectionStart: 3, selectionEnd: 5 }],
    ["bold", "", 0, 0, { value: "****", selectionStart: 2, selectionEnd: 2 }],
    ["link", "note", 0, 4, { value: "[note]()", selectionStart: 7, selectionEnd: 7 }],
    ["link", "", 0, 0, { value: "[]()", selectionStart: 3, selectionEnd: 3 }],
    ["bullet", "\nabc", 0, 0, { value: "- \nabc", selectionStart: 2, selectionEnd: 2 }],
    ["checkbox", "\nabc", 0, 0, { value: "- [ ] \nabc", selectionStart: 6, selectionEnd: 6 }],
  ])("formats %s and retains its expected selection", (action, value, start, end, expected) => {
    expect(applyMarkdownToolbarAction(action, value, start, end)).toEqual(expected);
  });
});

function ControlledEditor({
  initialValue,
  editorRef,
}: {
  initialValue: string;
  editorRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const [value, setValue] = useState(initialValue);
  return <MarkdownEditor ref={editorRef} aria-label="Notes" value={value} onChange={setValue} />;
}

describe("MarkdownEditor", () => {
  it("applies every toolbar action and restores focus and caret", async () => {
    const cases: Array<[string, MarkdownToolbarAction, string, number, number, string, number, number]> = [
      ["Aufzählung", "bullet", "note", 0, 4, "- note", 2, 6],
      ["Checkbox", "checkbox", "note", 0, 4, "- [ ] note", 6, 10],
      ["Fett", "bold", "note", 1, 3, "n**ot**e", 3, 5],
      ["Link einfügen", "link", "note", 0, 4, "[note]()", 7, 7],
    ];

    for (const [label, _action, initialValue, start, end, expectedValue, expectedStart, expectedEnd] of cases) {
      const { unmount } = render(<ControlledEditor initialValue={initialValue} />);
      const textarea = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(start, end);
      fireEvent.click(screen.getByRole("button", { name: label }));

      await waitFor(() => {
        expect(textarea).toHaveValue(expectedValue);
        expect(document.activeElement).toBe(textarea);
        expect(textarea.selectionStart).toBe(expectedStart);
        expect(textarea.selectionEnd).toBe(expectedEnd);
      });
      unmount();
    }
  });

  it("forwards its textarea ref for caller focus control", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<ControlledEditor initialValue="" editorRef={ref} />);

    expect(ref.current).toBe(screen.getByRole("textbox", { name: "Notes" }));
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });
});

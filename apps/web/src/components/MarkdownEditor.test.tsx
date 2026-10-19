import {
  markdownValue,
  markdownView,
  selectMarkdown,
  setMarkdownValue,
} from "../test/markdownEditor";
import { createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMarkdownToolbarAction,
  insertMarkdownAtSelection,
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownToolbarAction,
} from "./MarkdownEditor";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: {
    uploadPaperlessDocument: vi.fn(),
    searchPaperlessDocuments: vi.fn(),
  },
  paperlessDocumentThumbnailUrl: (id: number) =>
    `/api/integrations/paperless/documents/${id}/thumbnail`,
}));

const mockedApi = vi.mocked(api);

describe("applyMarkdownToolbarAction", () => {
  it.each<
    [
      MarkdownToolbarAction,
      string,
      number,
      number,
      { value: string; selectionStart: number; selectionEnd: number },
    ]
  >([
    [
      "bullet",
      "one\ntwo",
      0,
      7,
      { value: "- one\n- two", selectionStart: 2, selectionEnd: 11 },
    ],
    [
      "checkbox",
      "item",
      0,
      4,
      { value: "- [ ] item", selectionStart: 6, selectionEnd: 10 },
    ],
    [
      "bold",
      "note",
      1,
      3,
      { value: "n**ot**e", selectionStart: 3, selectionEnd: 5 },
    ],
    ["bold", "", 0, 0, { value: "****", selectionStart: 2, selectionEnd: 2 }],
    [
      "link",
      "note",
      0,
      4,
      { value: "[note]()", selectionStart: 7, selectionEnd: 7 },
    ],
    ["link", "", 0, 0, { value: "[]()", selectionStart: 3, selectionEnd: 3 }],
    [
      "bullet",
      "\nabc",
      0,
      0,
      { value: "- \nabc", selectionStart: 2, selectionEnd: 2 },
    ],
    [
      "checkbox",
      "\nabc",
      0,
      0,
      { value: "- [ ] \nabc", selectionStart: 6, selectionEnd: 6 },
    ],
  ])(
    "formats %s and retains its expected selection",
    (action, value, start, end, expected) => {
      expect(applyMarkdownToolbarAction(action, value, start, end)).toEqual(
        expected,
      );
    },
  );

  describe("insertMarkdownAtSelection", () => {
    it("replaces the selected text and leaves the caret after the attachment", () => {
      expect(
        insertMarkdownAtSelection(
          "before OLD after",
          7,
          10,
          "[file](paperless:3)",
        ),
      ).toEqual({
        value: "before [file](paperless:3) after",
        selectionStart: 26,
        selectionEnd: 26,
      });
    });
  });
});

function ControlledEditor({
  initialValue,
  editorRef,
}: {
  initialValue: string;
  editorRef?: React.RefObject<MarkdownEditorHandle>;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <MarkdownEditor
      ref={editorRef}
      aria-label="Notes"
      value={value}
      onChange={setValue}
    />
  );
}

describe("MarkdownEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies every toolbar action and restores focus and caret", async () => {
    const cases: Array<
      [
        string,
        MarkdownToolbarAction,
        string,
        number,
        number,
        string,
        number,
        number,
      ]
    > = [
      ["Aufzählung", "bullet", "note", 0, 4, "- note", 2, 6],
      ["Checkbox", "checkbox", "note", 0, 4, "- [ ] note", 6, 10],
      ["Fett", "bold", "note", 1, 3, "n**ot**e", 3, 5],
      ["Link einfügen", "link", "note", 0, 4, "[note]()", 7, 7],
    ];

    for (const [
      label,
      _action,
      initialValue,
      start,
      end,
      expectedValue,
      expectedStart,
      expectedEnd,
    ] of cases) {
      const { unmount } = render(
        <ControlledEditor initialValue={initialValue} />,
      );
      const textarea = screen.getByRole("textbox", {
        name: "Notes",
      }) as HTMLElement;
      textarea.focus();
      selectMarkdown(textarea, start, end);
      fireEvent.click(screen.getByRole("button", { name: label }));

      await waitFor(() => {
        expect(markdownValue(textarea)).toBe(expectedValue);
        expect(document.activeElement).toBe(textarea);
        expect(markdownView(textarea).state.selection.main.from).toBe(
          expectedStart,
        );
        expect(markdownView(textarea).state.selection.main.to).toBe(
          expectedEnd,
        );
      });
      unmount();
    }
  });

  it("forwards its textarea ref for caller focus control", () => {
    const ref = createRef<MarkdownEditorHandle>();
    render(<ControlledEditor initialValue="" editorRef={ref} />);

    expect(ref.current?.value).toBe("");
    ref.current?.focus();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Notes" }),
    );
  });

  it("uses native file inputs and requests the rear camera only for capture", () => {
    render(<ControlledEditor initialValue="" />);
    fireEvent.click(screen.getByRole("button", { name: "Anhang einfügen" }));

    expect(screen.getByLabelText("Foto aufnehmen")).toHaveAttribute(
      "capture",
      "environment",
    );
    expect(screen.getByLabelText("Bild auswählen")).not.toHaveAttribute(
      "capture",
    );
    expect(screen.getByLabelText("Datei auswählen")).not.toHaveAttribute(
      "capture",
    );
  });

  it.each([
    ["Foto aufnehmen", "photo.jpg", "image/jpeg", "![photo.jpg](paperless:21)"],
    [
      "Bild auswählen",
      "gallery.png",
      "image/png",
      "![gallery.png](paperless:21)",
    ],
    [
      "Datei auswählen",
      "manual.pdf",
      "application/pdf",
      "[manual.pdf](paperless:21)",
    ],
  ])(
    "uploads %s through the shared attachment flow and restores the caret",
    async (inputLabel, fileName, mimeType, markdown) => {
      mockedApi.uploadPaperlessDocument.mockResolvedValueOnce({
        id: 21,
        title: fileName,
        originalFileName: fileName,
        mimeType,
      });
      render(<ControlledEditor initialValue="before after" />);
      const textarea = screen.getByRole("textbox", {
        name: "Notes",
      }) as HTMLElement;
      textarea.focus();
      selectMarkdown(textarea, 7);

      fireEvent.click(screen.getByRole("button", { name: "Anhang einfügen" }));
      const file = new File(["content"], fileName, { type: mimeType });
      fireEvent.change(screen.getByLabelText(inputLabel), {
        target: { files: [file] },
      });
      if (inputLabel === "Foto aufnehmen") {
        fireEvent.click(
          await screen.findByRole("button", { name: "Original verwenden" }),
        );
      }

      await waitFor(() => {
        expect(markdownValue(textarea)).toBe(`before ${markdown}after`);
        expect(markdownView(textarea).state.selection.main.from).toBe(
          7 + markdown.length,
        );
        expect(markdownView(textarea).state.selection.main.to).toBe(
          7 + markdown.length,
        );
        expect(document.activeElement).toBe(textarea);
      });
      expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledWith(file);
    },
  );

  it("inserts an existing Paperless result without uploading it", async () => {
    mockedApi.searchPaperlessDocuments.mockResolvedValueOnce([
      {
        id: 33,
        title: "Lease",
        originalFileName: "lease.pdf",
        mimeType: "application/pdf",
      },
    ]);
    render(<ControlledEditor initialValue="" />);
    fireEvent.click(screen.getByRole("button", { name: "Anhang einfügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Aus Paperless …" }));
    await userEvent.type(
      screen.getByPlaceholderText("Dokumente in Paperless suchen"),
      "lease",
    );
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    fireEvent.click(await screen.findByRole("button", { name: /Lease/ }));

    expect(markdownValue(screen.getByRole("textbox", { name: "Notes" }))).toBe(
      "[lease.pdf](paperless:33)",
    );
    expect(mockedApi.uploadPaperlessDocument).not.toHaveBeenCalled();
  });

  it("keeps notes unchanged when an upload fails", async () => {
    mockedApi.uploadPaperlessDocument.mockRejectedValueOnce(
      new Error("Paperless unavailable"),
    );
    render(<ControlledEditor initialValue="unchanged" />);
    fireEvent.click(screen.getByRole("button", { name: "Anhang einfügen" }));
    fireEvent.change(screen.getByLabelText("Datei auswählen"), {
      target: {
        files: [
          new File(["content"], "manual.pdf", { type: "application/pdf" }),
        ],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Paperless unavailable",
    );
    expect(markdownValue(screen.getByRole("textbox", { name: "Notes" }))).toBe(
      "unchanged",
    );
  });

  it("keeps the editor modal while an attachment upload is in flight", async () => {
    let finishUpload!: (value: {
      id: number;
      title: string;
      originalFileName: string;
      mimeType: string;
    }) => void;
    mockedApi.uploadPaperlessDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    render(<ControlledEditor initialValue="note" />);
    fireEvent.click(screen.getByRole("button", { name: "Anhang einfügen" }));
    fireEvent.change(screen.getByLabelText("Datei auswählen"), {
      target: {
        files: [
          new File(["content"], "manual.pdf", { type: "application/pdf" }),
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.getByRole("dialog", { name: "Anhang" })).toBeInTheDocument();

    finishUpload({
      id: 71,
      title: "manual",
      originalFileName: "manual.pdf",
      mimeType: "application/pdf",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Anhang" }),
      ).not.toBeInTheDocument(),
    );
    expect(markdownValue(screen.getByRole("textbox", { name: "Notes" }))).toBe(
      "[manual.pdf](paperless:71)note",
    );
  });
});

describe("CodeMirror Markdown input", () => {
  it.each([
    ["- first", "- first\n- "],
    ["9. item", "9. item\n10. "],
    ["- [x] done", "- [x] done\n- [ ] "],
    ["- first\n- ", "- first\n"],
    ["- parent\n  - child\n  - ", "- parent\n  - child\n- "],
    ["```\n- code", "```\n- code\n"],
    ["    - code", "    - code\n    "],
  ])("continues Markdown context for %s", (value, expected) => {
    render(<ControlledEditor initialValue={value} />);
    const editor = screen.getByRole("textbox");
    selectMarkdown(editor, value.length);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(markdownValue(editor)).toBe(expected);
  });
  it("retains the suffix for mid-line edits and keeps Shift+Enter plain", () => {
    render(<ControlledEditor initialValue="- hello world" />);
    const editor = screen.getByRole("textbox");
    selectMarkdown(editor, 7);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(markdownValue(editor)).toBe("- hello\n-  world");
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter", shiftKey: true });
    expect(markdownValue(editor)).toBe("- hello\n- \n world");
  });
  it("applies external values without echoing changes and updates readonly state", () => {
    const change = vi.fn();
    const { rerender } = render(
      <MarkdownEditor aria-label="Notes" value="old" onChange={change} />,
    );
    const editor = screen.getByRole("textbox");
    selectMarkdown(editor, 2);
    rerender(
      <MarkdownEditor
        aria-label="Notes"
        value="updated"
        onChange={change}
        readOnly
      />,
    );
    expect(markdownValue(editor)).toBe("updated");
    expect(markdownView(editor).state.selection.main.from).toBe(2);
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Fett" })).toBeDisabled();
  });
  it("does not carry undo or redo across an external document replacement", () => {
    const change = vi.fn();
    const { rerender } = render(
      <MarkdownEditor aria-label="Notes" value="old" onChange={change} />,
    );
    const editor = screen.getByRole("textbox");
    setMarkdownValue(editor, "old edited");
    rerender(
      <MarkdownEditor
        aria-label="Notes"
        value="replacement"
        onChange={change}
      />,
    );
    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(markdownValue(editor)).toBe("replacement");
    fireEvent.keyDown(editor, {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(markdownValue(editor)).toBe("replacement");
  });
  it("keeps Tab available for normal focus navigation", async () => {
    render(
      <>
        <ControlledEditor initialValue="text" />
        <button>After editor</button>
      </>,
    );
    screen.getByRole("textbox").focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After editor" })).toHaveFocus();
  });
  it("lets caller key handling cancel Enter and leaves Tab unbound", () => {
    const handler = vi.fn((event: React.KeyboardEvent) =>
      event.preventDefault(),
    );
    render(
      <MarkdownEditor
        aria-label="Notes"
        value="- first"
        onChange={vi.fn()}
        onKeyDown={handler}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(handler).toHaveBeenCalled();
    expect(markdownValue(screen.getByRole("textbox"))).toBe("- first");
  });
});

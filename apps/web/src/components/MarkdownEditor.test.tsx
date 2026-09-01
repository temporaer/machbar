import { createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMarkdownToolbarAction,
  insertMarkdownAtSelection,
  MarkdownEditor,
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

  describe("insertMarkdownAtSelection", () => {
    it("replaces the selected text and leaves the caret after the attachment", () => {
      expect(insertMarkdownAtSelection("before OLD after", 7, 10, "[file](paperless:3)")).toEqual({
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
  editorRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const [value, setValue] = useState(initialValue);
  return <MarkdownEditor ref={editorRef} aria-label="Notes" value={value} onChange={setValue} />;
}

describe("MarkdownEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    ["Bild auswählen", "gallery.png", "image/png", "![gallery.png](paperless:21)"],
    ["Datei auswählen", "manual.pdf", "application/pdf", "[manual.pdf](paperless:21)"],
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
      const textarea = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(7, 7);

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
        expect(textarea).toHaveValue(`before ${markdown}after`);
        expect(textarea.selectionStart).toBe(7 + markdown.length);
        expect(textarea.selectionEnd).toBe(7 + markdown.length);
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

    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(
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
        files: [new File(["content"], "manual.pdf", { type: "application/pdf" })],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Paperless unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(
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
        files: [new File(["content"], "manual.pdf", { type: "application/pdf" })],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(
      screen.getByRole("dialog", { name: "Anhang" }),
    ).toBeInTheDocument();

    finishUpload({
      id: 71,
      title: "manual",
      originalFileName: "manual.pdf",
      mimeType: "application/pdf",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Anhang" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(
      "[manual.pdf](paperless:71)note",
    );
  });
});

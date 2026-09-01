import { describe, expect, it, vi } from "vitest";
import {
  extractPaperlessReferences,
  containsPaperlessReference,
  markdownWithoutPaperlessReferences,
  paperlessAttachmentBlock,
  paperlessDocumentId,
  paperlessMarkdownReference,
  uploadPaperlessFile,
  uploadPaperlessFiles,
} from "./paperlessAttachments";

describe("Paperless Markdown attachments", () => {
  it("renders images and documents with escaped labels", () => {
    expect(
      paperlessMarkdownReference({
        id: 12,
        title: "Photo",
        originalFileName: "yard [before].jpg",
        mimeType: "image/jpeg",
      }),
    ).toBe("![yard \\[before\\].jpg](paperless:12)");
    expect(
      paperlessMarkdownReference({
        id: 13,
        title: "Manual",
        originalFileName: "manual.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe("[manual.pdf](paperless:13)");
  });

  it("rejects IDs that cannot form a stable Paperless reference", () => {
    expect(() =>
      paperlessMarkdownReference({
        id: 0,
        title: "Broken",
        originalFileName: "broken.pdf",
        mimeType: "application/pdf",
      }),
    ).toThrow(/positive integers/);
  });

  it("extracts valid references in order and projects authored notes separately", () => {
    const markdown = [
      "Call the installer",
      "",
      "![yard \\[before\\].jpg](paperless:12)",
      "",
      "[manual.pdf](paperless:13)",
      "",
      "[broken](paperless:0)",
      "[overflow](paperless:999999999999999999999)",
    ].join("\n");

    expect(extractPaperlessReferences(markdown)).toEqual([
      { id: 12, label: "yard [before].jpg", kind: "image" },
      { id: 13, label: "manual.pdf", kind: "document" },
    ]);
    expect(markdownWithoutPaperlessReferences(markdown)).toBe(
      "Call the installer\n\n[broken](paperless:0)\n[overflow](paperless:999999999999999999999)",
    );
  });

  it("accepts only positive safe Paperless IDs", () => {
    expect(paperlessDocumentId("paperless:1")).toBe(1);
    expect(paperlessDocumentId("paperless:0")).toBeNull();
    expect(paperlessDocumentId("paperless:-1")).toBeNull();
    expect(paperlessDocumentId("paperless:01")).toBeNull();
    expect(paperlessDocumentId("paperless:999999999999999999999")).toBeNull();
  });

  it("ignores Paperless-shaped literal code and escaped Markdown", () => {
    const markdown = [
      "`[inline](paperless:1)`",
      "",
      "\\[escaped](paperless:2)",
      "",
      "```text",
      "[fenced](paperless:3)",
      "```",
      "",
      "[real](paperless:4)",
    ].join("\n");

    expect(extractPaperlessReferences(markdown)).toEqual([
      { id: 4, label: "real", kind: "document" },
    ]);
    expect(markdownWithoutPaperlessReferences(markdown)).toContain(
      "`[inline](paperless:1)`",
    );
    expect(markdownWithoutPaperlessReferences(markdown)).not.toContain(
      "[real](paperless:4)",
    );
  });

  it("recognizes an already-attached Paperless document idempotently", () => {
    expect(
      containsPaperlessReference(
        "![receipt](paperless:42)",
        "[receipt.pdf](paperless:42)",
      ),
    ).toBe(true);
    expect(
      containsPaperlessReference(
        "![receipt](paperless:42)",
        "[manual.pdf](paperless:43)",
      ),
    ).toBe(false);
  });

  it("uses the selected file metadata when Paperless omits it", async () => {
    const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });
    const upload = vi.fn().mockResolvedValue({
      id: 41,
      title: "photo",
      originalFileName: "",
      mimeType: null,
    });

    await expect(uploadPaperlessFile(file, upload)).resolves.toMatchObject({
      markdown: "![photo.jpg](paperless:41)",
      document: {
        id: 41,
        originalFileName: "photo.jpg",
        mimeType: "image/jpeg",
      },
    });
  });

  it("uploads multiple files through the same primitive and builds one block", async () => {
    const files = [
      new File(["one"], "one.png", { type: "image/png" }),
      new File(["two"], "two.pdf", { type: "application/pdf" }),
    ];
    const upload = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1,
        title: "one",
        originalFileName: "one.png",
        mimeType: "image/png",
      })
      .mockResolvedValueOnce({
        id: 2,
        title: "two",
        originalFileName: "two.pdf",
        mimeType: "application/pdf",
      });

    const attachments = await uploadPaperlessFiles(files, upload);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(paperlessAttachmentBlock(attachments)).toBe(
      "![one.png](paperless:1)\n\n[two.pdf](paperless:2)",
    );
  });
});

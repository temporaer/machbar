import { describe, expect, it, vi } from "vitest";
import {
  paperlessAttachmentBlock,
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

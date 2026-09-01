import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { MarkdownAttachmentSheet } from "./MarkdownAttachmentSheet";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      uploadPaperlessDocument: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api, true);

describe("MarkdownAttachmentSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries delivery with the resolved reference without uploading again", async () => {
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 42,
      title: "Receipt",
      originalFileName: "receipt.jpg",
      mimeType: "image/jpeg",
    });
    const onInsert = vi
      .fn<(markdown: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Update failed"))
      .mockResolvedValueOnce();
    const onClose = vi.fn();
    render(<MarkdownAttachmentSheet onInsert={onInsert} onClose={onClose} />);

    await userEvent.upload(
      screen.getByLabelText("Bild auswählen"),
      new File(["image"], "receipt.jpg", { type: "image/jpeg" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Update failed");
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(onInsert).toHaveBeenLastCalledWith("![receipt.jpg](paperless:42)");
    expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1);
  });
});

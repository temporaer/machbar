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
      preparePaperlessImageForCrop: vi.fn(),
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

  it("offers cropping before uploading a newly captured photo", async () => {
    mockedApi.preparePaperlessImageForCrop.mockReturnValue(
      new Promise(() => undefined),
    );
    mockedApi.uploadPaperlessDocument.mockResolvedValue({
      id: 43,
      title: "Photo",
      originalFileName: "photo.jpg",
      mimeType: "image/jpeg",
    });
    const onInsert = vi.fn().mockResolvedValue(undefined);
    render(<MarkdownAttachmentSheet onInsert={onInsert} onClose={vi.fn()} />);

    await userEvent.upload(
      screen.getByLabelText("Foto aufnehmen"),
      new File(["image"], "photo.jpg", { type: "image/jpeg" }),
    );

    expect(
      await screen.findByRole("button", { name: "Foto zuschneiden" }),
    ).toBeInTheDocument();
    expect(mockedApi.uploadPaperlessDocument).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Foto zuschneiden" }));
    expect(
      await screen.findByRole("dialog", { name: "Foto zuschneiden" }),
    ).toBeInTheDocument();
    expect(mockedApi.uploadPaperlessDocument).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Original verwenden" }));
    await waitFor(() =>
      expect(mockedApi.uploadPaperlessDocument).toHaveBeenCalledTimes(1),
    );
  });

  it("opens the bounded in-app camera for a new photo", async () => {
    render(<MarkdownAttachmentSheet onInsert={vi.fn()} onClose={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Foto aufnehmen" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Foto aufnehmen" }),
    ).toBeInTheDocument();
  });
});

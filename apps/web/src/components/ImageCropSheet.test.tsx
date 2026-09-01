import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { ImageCropSheet } from "./ImageCropSheet";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      preparePaperlessImageForCrop: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api, true);

const jpeg = new File(
  [
    new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x03, 0xe8,
    ]),
  ],
  "photo.jpg",
  { type: "image/jpeg" },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("aborts preparation before decoding when the sheet closes", async () => {
  let resolvePreparation!: (blob: Blob) => void;
  mockedApi.preparePaperlessImageForCrop.mockReturnValue(
    new Promise((resolve) => {
      resolvePreparation = resolve;
    }),
  );
  const createImageBitmap = vi.fn();
  vi.stubGlobal("createImageBitmap", createImageBitmap);

  const { unmount } = renderWithProviders(
    <ImageCropSheet
      file={jpeg}
      onApply={vi.fn()}
      onUseOriginal={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(mockedApi.preparePaperlessImageForCrop).toHaveBeenCalled(),
  );
  const signal = mockedApi.preparePaperlessImageForCrop.mock.calls[0]?.[1];

  unmount();
  expect(signal?.aborted).toBe(true);
  resolvePreparation(new Blob(["prepared"], { type: "image/jpeg" }));
  await Promise.resolve();
  await Promise.resolve();

  expect(createImageBitmap).not.toHaveBeenCalled();
});

it("invalidates an in-flight crop when the sheet closes", async () => {
  mockedApi.preparePaperlessImageForCrop.mockResolvedValue(
    new Blob(["prepared"], { type: "image/jpeg" }),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 1000, height: 800, close: vi.fn() }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  let finishEncoding!: () => void;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => {
      finishEncoding = () =>
        callback(new Blob(["cropped"], { type: "image/jpeg" }));
    },
  );
  const onApply = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <ImageCropSheet
        file={jpeg}
        onApply={onApply}
        onUseOriginal={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    ) : null;
  }

  renderWithProviders(<Harness />);
  const apply = await screen.findByRole("button", {
    name: "Ausschnitt verwenden",
  });
  await waitFor(() => expect(apply).toBeEnabled());
  await userEvent.click(apply);
  expect(
    screen.getByRole("button", { name: "Original verwenden" }),
  ).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
  finishEncoding();
  await Promise.resolve();

  expect(onApply).not.toHaveBeenCalled();
});

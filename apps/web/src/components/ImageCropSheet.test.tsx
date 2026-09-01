import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { ImageCropSheet } from "./ImageCropSheet";

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
});

it("invalidates an in-flight crop when the sheet closes", async () => {
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

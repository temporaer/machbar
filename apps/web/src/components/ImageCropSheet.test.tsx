import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:prepared");
  const revokeObjectURL = vi.fn();
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL },
  });
  return { createObjectURL, revokeObjectURL };
}

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
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

it("aborts preparation before decoding when the sheet closes", async () => {
  let resolvePreparation!: (blob: Blob) => void;
  mockedApi.preparePaperlessImageForCrop.mockReturnValue(
    new Promise((resolve) => {
      resolvePreparation = resolve;
    }),
  );
  const { createObjectURL } = stubObjectUrls();

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

  expect(createObjectURL).not.toHaveBeenCalled();
});

it("invalidates an in-flight crop when the sheet closes", async () => {
  stubObjectUrls();
  mockedApi.preparePaperlessImageForCrop.mockResolvedValue(
    new Blob(["prepared"], { type: "image/jpeg" }),
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
  const image = await screen.findByAltText("Vorschau des Bildausschnitts");
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1000 },
    naturalHeight: { configurable: true, value: 800 },
  });
  fireEvent.load(image);
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

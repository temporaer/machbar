import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraCaptureSheet } from "./CameraCaptureSheet";

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("CameraCaptureSheet", () => {
  it("captures a bounded frame and stops the camera", async () => {
    const stop = vi.fn();
    const track = {
      stop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["photo"], { type: "image/jpeg" })),
    );
    const onCapture = vi.fn();

    const { unmount } = render(
      <CameraCaptureSheet
        onCapture={onCapture}
        onFallback={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 1280, max: 1280 },
      },
    });
    const video = screen.getByLabelText("Kameravorschau");
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    fireEvent.canPlay(video);

    await userEvent.click(
      screen.getByRole("button", { name: "Foto aufnehmen" }),
    );
    await waitFor(() => expect(onCapture).toHaveBeenCalled());
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    const file = onCapture.mock.calls[0]?.[0] as File;
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/^photo-.*\.jpg$/);
    expect(stop).toHaveBeenCalledOnce();

    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the stream and offers the device picker when playback fails", async () => {
    const stop = vi.fn();
    const track = {
      stop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
        }),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("Playback failed"),
    );
    const onFallback = vi.fn();

    render(
      <CameraCaptureSheet
        onCapture={vi.fn()}
        onFallback={onFallback}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Kamera konnte nicht direkt geöffnet werden",
    );
    expect(stop).toHaveBeenCalledOnce();
    await userEvent.click(
      screen.getByRole("button", { name: "Bild auswählen" }),
    );
    expect(onFallback).toHaveBeenCalledOnce();
  });
});

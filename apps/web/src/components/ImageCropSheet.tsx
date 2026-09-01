import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

const MAX_CROP_WIDTH = 1280;
const PREVIEW_WIDTH = 720;
const MIN_REMAINING_PERCENT = 20;

interface CropInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const initialInsets: CropInsets = {
  top: 5,
  right: 5,
  bottom: 5,
  left: 5,
};

function croppedFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "photo";
  return `${base}-cropped.jpg`;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not create the cropped image."));
      },
      "image/jpeg",
      0.9,
    );
  });
}

export function ImageCropSheet({
  file,
  onApply,
  onUseOriginal,
  onClose,
}: {
  file: File;
  onApply: (file: File) => void;
  onUseOriginal: () => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const applyVersionRef = useRef(0);
  const [insets, setInsets] = useState<CropInsets>(initialInsets);
  const [ready, setReady] = useState(false);
  const [previewSize, setPreviewSize] = useState({ width: 1, height: 1 });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setReady(false);
    setError(null);

    if (typeof createImageBitmap !== "function") {
      setError(strings.cropUnavailable);
      return;
    }

    void api
      .preparePaperlessImageForCrop(file, controller.signal)
      .then((prepared) => {
        if (disposed) return null;
        return createImageBitmap(prepared);
      })
      .then((bitmap) => {
        if (!bitmap) return;
        if (disposed) {
          bitmap.close();
          return;
        }
        if (
          bitmap.width > MAX_CROP_WIDTH ||
          bitmap.height > MAX_CROP_WIDTH
        ) {
          bitmap.close();
          setError(strings.cropUnavailable);
          return;
        }
        bitmapRef.current = bitmap;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          bitmap.close();
          bitmapRef.current = null;
          setError(strings.cropUnavailable);
          return;
        }
        const scale = Math.min(1, PREVIEW_WIDTH / bitmap.width);
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        setPreviewSize({ width: canvas.width, height: canvas.height });
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setError(strings.cropUnavailable);
      });

    return () => {
      disposed = true;
      controller.abort();
      applyVersionRef.current += 1;
      bitmapRef.current?.close();
      bitmapRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [file, strings.cropUnavailable]);

  const setInset = (edge: keyof CropInsets, value: number) => {
    setInsets((current) => ({ ...current, [edge]: value }));
  };

  const apply = async () => {
    const bitmap = bitmapRef.current;
    if (!bitmap || applying) return;
    setApplying(true);
    setError(null);
    const applyVersion = ++applyVersionRef.current;
    const output = document.createElement("canvas");
    try {
      const sourceX = Math.round((insets.left / 100) * bitmap.width);
      const sourceY = Math.round((insets.top / 100) * bitmap.height);
      const sourceWidth = Math.max(
        1,
        Math.round(((100 - insets.left - insets.right) / 100) * bitmap.width),
      );
      const sourceHeight = Math.max(
        1,
        Math.round(((100 - insets.top - insets.bottom) / 100) * bitmap.height),
      );
      const outputScale = Math.min(
        1,
        MAX_CROP_WIDTH / sourceWidth,
        MAX_CROP_WIDTH / sourceHeight,
      );
      output.width = Math.max(1, Math.round(sourceWidth * outputScale));
      output.height = Math.max(1, Math.round(sourceHeight * outputScale));
      const context = output.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.drawImage(
        bitmap,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        output.width,
        output.height,
      );
      const blob = await canvasBlob(output);
      if (applyVersionRef.current !== applyVersion) return;
      onApply(
        new File([blob], croppedFileName(file.name), {
          type: "image/jpeg",
          lastModified: Date.now(),
        }),
      );
    } catch {
      setError(strings.cropUnavailable);
      setApplying(false);
    } finally {
      output.width = 0;
      output.height = 0;
    }
  };

  const cropStyle = {
    inset: `${insets.top}% ${insets.right}% ${insets.bottom}% ${insets.left}%`,
  };

  return (
    <BottomSheet title={strings.cropImage} onClose={onClose}>
      <div className="stack image-crop-sheet">
        <div className="image-crop-preview" aria-busy={!ready}>
          <div
            className="image-crop-canvas-frame"
            style={{
              aspectRatio: `${previewSize.width} / ${previewSize.height}`,
              width: `min(100%, ${previewSize.width}px, calc(48vh * ${previewSize.width / previewSize.height}))`,
            }}
          >
            <canvas ref={canvasRef} aria-label={strings.cropPreview} />
            {ready ? (
              <span className="image-crop-selection" style={cropStyle} />
            ) : null}
          </div>
          {!ready && !error ? (
            <span className="image-crop-loading">{strings.cropPreparing}</span>
          ) : null}
        </div>

        {ready ? (
          <div className="image-crop-controls">
            {(["left", "right", "top", "bottom"] as const).map((edge) => {
              const opposite =
                edge === "left"
                  ? "right"
                  : edge === "right"
                    ? "left"
                    : edge === "top"
                      ? "bottom"
                      : "top";
              return (
                <label key={edge}>
                  <span>{strings.cropEdge[edge]}</span>
                  <input
                    type="range"
                    min="0"
                    max={100 - insets[opposite] - MIN_REMAINING_PERCENT}
                    value={insets[edge]}
                    disabled={applying}
                    onChange={(event) => setInset(edge, Number(event.target.value))}
                  />
                </label>
              );
            })}
          </div>
        ) : null}

        {error ? <p className="capture-error" role="alert">{error}</p> : null}
        <div className="sheet-actions">
          <button
            type="button"
            className="btn"
            disabled={applying}
            onClick={onUseOriginal}
          >
            {strings.useOriginal}
          </button>
          {ready ? (
            <button
              type="button"
              className="btn"
              disabled={applying}
              onClick={() => setInsets(initialInsets)}
            >
              {strings.cropReset}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || applying}
            onClick={() => void apply()}
          >
            {applying ? strings.cropApplying : strings.applyCrop}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

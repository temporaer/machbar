import { useEffect, useRef, useState } from "react";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

const MAX_CROP_WIDTH = 1280;
const initialCrop: PercentCrop = {
  unit: "%",
  x: 5,
  y: 5,
  width: 90,
  height: 90,
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
  const imageRef = useRef<HTMLImageElement>(null);
  const applyVersionRef = useRef(0);
  const [crop, setCrop] = useState<PercentCrop>(initialCrop);
  const [preparedUrl, setPreparedUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = preparedUrl !== null && naturalSize.width > 0;

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setPreparedUrl(null);
    setNaturalSize({ width: 0, height: 0 });
    setCrop(initialCrop);
    setError(null);

    void api
      .preparePaperlessImageForCrop(file, controller.signal)
      .then((prepared) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(prepared);
        setPreparedUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setError(strings.cropUnavailable);
      });

    return () => {
      disposed = true;
      controller.abort();
      applyVersionRef.current += 1;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, strings.cropUnavailable]);

  const apply = async () => {
    const image = imageRef.current;
    if (!image || !ready || applying) return;
    setApplying(true);
    setError(null);
    const applyVersion = ++applyVersionRef.current;
    const output = document.createElement("canvas");
    try {
      const sourceX = Math.round((crop.x / 100) * naturalSize.width);
      const sourceY = Math.round((crop.y / 100) * naturalSize.height);
      const sourceWidth = Math.max(
        1,
        Math.round((crop.width / 100) * naturalSize.width),
      );
      const sourceHeight = Math.max(
        1,
        Math.round((crop.height / 100) * naturalSize.height),
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
        image,
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

  const edge = strings.cropEdge;
  return (
    <BottomSheet title={strings.cropImage} onClose={onClose}>
      <div className="stack image-crop-sheet">
        <div className="image-crop-preview" aria-busy={!ready && !error}>
          {preparedUrl ? (
            <ReactCrop
              className="image-crop-frame"
              crop={crop}
              keepSelection
              ruleOfThirds
              disabled={applying}
              minWidth={32}
              minHeight={32}
              ariaLabels={{
                cropArea: strings.cropPreview,
                nwDragHandle: `${edge.top} ${edge.left}`,
                nDragHandle: edge.top,
                neDragHandle: `${edge.top} ${edge.right}`,
                eDragHandle: edge.right,
                seDragHandle: `${edge.bottom} ${edge.right}`,
                sDragHandle: edge.bottom,
                swDragHandle: `${edge.bottom} ${edge.left}`,
                wDragHandle: edge.left,
              }}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
            >
              <img
                ref={imageRef}
                src={preparedUrl}
                alt={strings.cropPreview}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (
                    image.naturalWidth > MAX_CROP_WIDTH ||
                    image.naturalHeight > MAX_CROP_WIDTH
                  ) {
                    setError(strings.cropUnavailable);
                    return;
                  }
                  setNaturalSize({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  });
                }}
                onError={() => setError(strings.cropUnavailable)}
              />
            </ReactCrop>
          ) : null}
          {!ready && !error ? (
            <span className="image-crop-loading">{strings.cropPreparing}</span>
          ) : null}
        </div>

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
          <button
            type="button"
            className="btn"
            disabled={!ready || applying}
            onClick={() => setCrop(initialCrop)}
          >
            {strings.cropReset}
          </button>
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

import { useEffect, useRef, useState } from "react";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

const MAX_CAPTURE_DIMENSION = 1280;

function capturedFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `photo-${stamp}.jpg`;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not capture the photo."));
      },
      "image/jpeg",
      0.9,
    );
  });
}

export function CameraCaptureSheet({
  onCapture,
  onFallback,
  onClose,
}: {
  onCapture: (file: File) => void;
  onFallback: () => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureVersionRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let tracks: MediaStreamTrack[] = [];
    const onTrackEnded = () => {
      if (disposed) return;
      setReady(false);
      setError(strings.cameraUnavailable);
    };
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setError(strings.cameraUnavailable);
      return;
    }

    void mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: MAX_CAPTURE_DIMENSION, max: MAX_CAPTURE_DIMENSION },
          height: { ideal: MAX_CAPTURE_DIMENSION, max: MAX_CAPTURE_DIMENSION },
        },
      })
      .then(async (stream) => {
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        tracks = stream.getTracks();
        tracks.forEach((track) =>
          track.addEventListener("ended", onTrackEnded, { once: true }),
        );
        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          setError(strings.cameraUnavailable);
          return;
        }
        video.srcObject = stream;
        await video.play();
      })
      .catch(() => {
        const stream = streamRef.current;
        stream?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const video = videoRef.current;
        if (video) video.srcObject = null;
        if (!disposed) setError(strings.cameraUnavailable);
      });

    return () => {
      disposed = true;
      captureVersionRef.current += 1;
      tracks.forEach((track) => track.removeEventListener("ended", onTrackEnded));
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [strings.cameraUnavailable]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || !ready || capturing) return;
    setCapturing(true);
    setError(null);
    const captureVersion = ++captureVersionRef.current;
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(
        1,
        MAX_CAPTURE_DIMENSION / video.videoWidth,
        MAX_CAPTURE_DIMENSION / video.videoHeight,
      );
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      if (captureVersionRef.current !== captureVersion) return;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      video.srcObject = null;
      setReady(false);
      onCapture(
        new File([blob], capturedFileName(), {
          type: "image/jpeg",
          lastModified: Date.now(),
        }),
      );
    } catch {
      if (captureVersionRef.current === captureVersion) {
        setError(strings.cameraUnavailable);
        setCapturing(false);
      }
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  };

  return (
    <BottomSheet title={strings.takePhoto} onClose={onClose}>
      <div className="stack camera-capture-sheet">
        <div className="camera-capture-preview" aria-busy={!ready && !error}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label={strings.cameraPreview}
            onCanPlay={() => setReady(true)}
          />
          {!ready && !error ? (
            <span className="camera-capture-status">{strings.cameraStarting}</span>
          ) : null}
        </div>
        {error ? <p className="capture-error" role="alert">{error}</p> : null}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onFallback}>
            {strings.chooseImage}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || capturing}
            onClick={() => void capture()}
          >
            {capturing ? strings.cameraCapturing : strings.takePhoto}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

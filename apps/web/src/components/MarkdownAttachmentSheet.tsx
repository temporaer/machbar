import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { PaperlessDocumentSummary } from "@machbar/shared";
import {
  api,
  paperlessDocumentThumbnailUrl,
} from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import {
  paperlessMarkdownReference,
  uploadPaperlessFile,
} from "../lib/paperlessAttachments";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { ImageCropSheet } from "./ImageCropSheet";
import { PendingMaterialPreview } from "./PendingMaterialPreview";
import { CameraCaptureSheet } from "./CameraCaptureSheet";

export function MarkdownAttachmentSheet({
  onInsert,
  onClose,
}: {
  onInsert: (markdown: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const strings = useStrings();
  const cameraRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [resolvedMarkdown, setResolvedMarkdown] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaperlessDocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraFile, setCameraFile] = useState<File | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const deliver = async (markdown: string) => {
    setResolvedMarkdown(markdown);
    setDelivering(true);
    setError(null);
    try {
      await onInsert(markdown);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setDelivering(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setResolvedMarkdown(null);
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadPaperlessFile(file);
      await deliver(attachment.markdown);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const selectFile = (
    event: ChangeEvent<HTMLInputElement>,
    offerCrop = false,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploading) return;

    if (offerCrop && file.type.startsWith("image/")) {
      setCameraFile(file);
      return;
    }
    void uploadFile(file);
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || searching) return;
    setSearching(true);
    setResolvedMarkdown(null);
    setError(null);
    try {
      setResults(await api.searchPaperlessDocuments(normalized));
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSearching(false);
    }
  };

  const chooseDocument = async (document: PaperlessDocumentSummary) => {
    await deliver(paperlessMarkdownReference(document));
  };

  const busy = uploading || searching || delivering;

  return (
    <>
      <BottomSheet
        title={strings.paperlessAttachmentTitle}
        onClose={() => {
          if (!busy) onClose();
        }}
        headerStatus={
          uploading
            ? strings.paperlessUploading
            : delivering
              ? strings.save
              : undefined
        }
      >
        <div className="stack markdown-attachment-sheet">
          <input
            ref={cameraRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label={strings.takePhoto}
            onChange={(event) => selectFile(event, true)}
          />
          <input
            ref={imageRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            aria-label={strings.chooseImage}
            onChange={selectFile}
          />
          <input
            ref={fileRef}
            className="visually-hidden"
            type="file"
            aria-label={strings.chooseFile}
            onChange={selectFile}
          />

        {cameraFile ? (
          <div className="stack">
            <PendingMaterialPreview
              files={[cameraFile]}
              onCrop={() => setCropFile(cameraFile)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                const original = cameraFile;
                setCameraFile(null);
                void uploadFile(original);
              }}
            >
              {strings.useOriginal}
            </button>
          </div>
        ) : (
          <div className="markdown-attachment-actions">
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => setCameraOpen(true)}
          >
            {strings.takePhoto}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => imageRef.current?.click()}
          >
            {strings.chooseImage}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {strings.chooseFile}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => {
              setSearchOpen(true);
              setError(null);
            }}
          >
            {strings.fromPaperless}
          </button>
          </div>
        )}

        {searchOpen ? (
          <form className="stack" onSubmit={(event) => void search(event)}>
            <label className="field">
              <span>{strings.fromPaperless}</span>
              <input
                type="search"
                value={query}
                placeholder={strings.paperlessSearchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={searching || !query.trim()}
            >
              {searching ? strings.paperlessSearching : strings.paperlessSearch}
            </button>
          </form>
        ) : null}

        {results?.length === 0 ? (
          <p className="text-muted">{strings.paperlessSearchEmpty}</p>
        ) : null}
        {results && results.length > 0 ? (
          <div className="paperless-search-results">
            {results.map((document) => (
              <button
                key={document.id}
                type="button"
                className="paperless-search-result"
                disabled={busy}
                onClick={() => void chooseDocument(document)}
              >
                <img
                  src={paperlessDocumentThumbnailUrl(document.id)}
                  alt=""
                  loading="lazy"
                />
                <span>
                  <strong>{document.title}</strong>
                  <small>{document.originalFileName}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="stack">
            <p className="capture-error" role="alert">{error}</p>
            {resolvedMarkdown ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void deliver(resolvedMarkdown)}
              >
                {strings.retry}
              </button>
            ) : null}
          </div>
        ) : null}
        </div>
      </BottomSheet>
      {cropFile ? (
        <ImageCropSheet
          file={cropFile}
          onClose={() => setCropFile(null)}
          onUseOriginal={() => {
            const original = cameraFile ?? cropFile;
            setCameraFile(null);
            setCropFile(null);
            void uploadFile(original);
          }}
          onApply={(cropped) => {
            setCameraFile(null);
            setCropFile(null);
            void uploadFile(cropped);
          }}
        />
      ) : null}
      {cameraOpen ? (
        <CameraCaptureSheet
          onClose={() => setCameraOpen(false)}
          onFallback={() => {
            setCameraOpen(false);
            cameraRef.current?.click();
          }}
          onCapture={(file) => {
            setCameraOpen(false);
            setCameraFile(file);
          }}
        />
      ) : null}
    </>
  );
}

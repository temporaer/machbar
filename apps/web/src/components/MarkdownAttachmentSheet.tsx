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

export function MarkdownAttachmentSheet({
  onInsert,
  onClose,
}: {
  onInsert: (markdown: string) => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const cameraRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaperlessDocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploading) return;

    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadPaperlessFile(file);
      onInsert(attachment.markdown);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setUploading(false);
    }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || searching) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchPaperlessDocuments(normalized));
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSearching(false);
    }
  };

  const chooseDocument = (document: PaperlessDocumentSummary) => {
    onInsert(paperlessMarkdownReference(document));
  };

  const busy = uploading || searching;

  return (
    <BottomSheet
      title={strings.paperlessAttachmentTitle}
      onClose={() => {
        if (!busy) onClose();
      }}
      headerStatus={uploading ? strings.paperlessUploading : undefined}
    >
      <div className="stack markdown-attachment-sheet">
        <input
          ref={cameraRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          aria-label={strings.takePhoto}
          onChange={(event) => void selectFile(event)}
        />
        <input
          ref={imageRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          aria-label={strings.chooseImage}
          onChange={(event) => void selectFile(event)}
        />
        <input
          ref={fileRef}
          className="visually-hidden"
          type="file"
          aria-label={strings.chooseFile}
          onChange={(event) => void selectFile(event)}
        />

        <div className="markdown-attachment-actions">
          <button
            type="button"
            className="btn btn-block"
            disabled={uploading}
            onClick={() => cameraRef.current?.click()}
          >
            {strings.takePhoto}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={uploading}
            onClick={() => imageRef.current?.click()}
          >
            {strings.chooseImage}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {strings.chooseFile}
          </button>
          <button
            type="button"
            className="btn btn-block"
            disabled={uploading}
            onClick={() => {
              setSearchOpen(true);
              setError(null);
            }}
          >
            {strings.fromPaperless}
          </button>
        </div>

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
                onClick={() => chooseDocument(document)}
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
        {error ? <p className="capture-error" role="alert">{error}</p> : null}
      </div>
    </BottomSheet>
  );
}

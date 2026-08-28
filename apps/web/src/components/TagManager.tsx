import { useState, type CSSProperties, type FormEvent } from "react";
import { tagKinds, type Tag, type TagKind } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { ErrorState, LoadingState } from "./AsyncStates";
import { BottomSheet } from "./BottomSheet";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { useLocale, type Locale } from "../lib/locale";

function errorMessage(error: unknown, strings: Strings): string {
  return localizedErrorMessage(error, strings);
}

function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function orderedPinnedTags(
  tags: Tag[],
  kind: TagKind,
  locale: Locale,
): Tag[] {
  return tags
    .filter((tag) => tag.kind === kind && tag.groupingMode === "pinned")
    .sort(
      (a, b) =>
        (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
          (b.sortPosition ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name, locale) ||
        a.id - b.id,
    );
}

export function TagManager() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const { bump } = useRefresh();
  const [name, setName] = useState("");
  const [createKind, setCreateKind] = useState<TagKind>("plain");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState<TagKind>("plain");
  const [editPreferred, setEditPreferred] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createTag(trimmed, createKind);
      setName("");
      reload();
      bump();
    } catch (cause) {
      setCreateError(errorMessage(cause, strings));
    } finally {
      setCreating(false);
    }
  };

  const startEditing = (tag: Tag) => {
    setEditing(tag);
    setEditName(tag.name);
    setEditKind(tag.kind);
    setEditPreferred(tag.groupingMode === "pinned");
    setConfirmingDelete(false);
    setEditorError(null);
  };

  const closeEditor = () => {
    if (saving || deleting) return;
    setEditing(null);
    setConfirmingDelete(false);
    setEditorError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || saving || !editName.trim()) return;
    setSaving(true);
    setEditorError(null);
    const targetPinned = orderedPinnedTags(tags ?? [], editKind, locale);
    try {
      await api.updateTag(editing.id, {
        name: editName.trim(),
        kind: editKind,
        groupingMode: editPreferred ? "pinned" : "auto",
        sortPosition: editPreferred
          ? editing.groupingMode === "pinned" && editing.kind === editKind
            ? editing.sortPosition ?? targetPinned.length
            : targetPinned.length
          : null,
      });
      reload();
      bump();
      setEditing(null);
    } catch (cause) {
      setEditorError(errorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || deleting) return;
    setDeleting(true);
    setEditorError(null);
    try {
      await api.deleteTag(editing.id);
      reload();
      bump();
      setEditing(null);
    } catch (cause) {
      setEditorError(errorMessage(cause, strings));
    } finally {
      setDeleting(false);
    }
  };

  const movePinned = async (tag: Tag, direction: -1 | 1) => {
    const ordered = orderedPinnedTags(tags ?? [], tag.kind, locale);
    const index = ordered.findIndex((candidate) => candidate.id === tag.id);
    const other = ordered[index + direction];
    if (!other) return;
    setUpdatingId(tag.id);
    setActionError(null);
    try {
      await api.updateTag(tag.id, {
        sortPosition: other.sortPosition ?? index + direction,
      });
      await api.updateTag(other.id, {
        sortPosition: tag.sortPosition ?? index,
      });
      reload();
      bump();
    } catch (cause) {
      setActionError(errorMessage(cause, strings));
    } finally {
      setUpdatingId(null);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const allTags = tags ?? [];
  const foldedQuery = foldForSearch(query.trim());
  const visibleTags = foldedQuery
    ? allTags.filter((tag) => foldForSearch(tag.name).includes(foldedQuery))
    : allTags;

  return (
    <div className="tag-manager stack">
      <section className="card stack">
        <div>
          <h2 className="tag-manager-panel-title">{strings.createTag}</h2>
          <p className="text-muted tag-manager-hint">{strings.createTagHint}</p>
        </div>
        <form className="stack" onSubmit={(event) => void create(event)}>
          <div className="field">
            <label htmlFor="new-tag-name">{strings.tagName}</label>
            <input
              id="new-tag-name"
              placeholder={strings.newTagPlaceholder}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="list-option-field">
            <span className="list-option-label">{strings.tagKind}</span>
            <div className="list-option-group" role="group" aria-label={strings.newTagType}>
              {tagKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="list-option-button"
                  aria-pressed={createKind === kind}
                  onClick={() => setCreateKind(kind)}
                >
                  {strings.tagKindLabels[kind]}
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || !name.trim()}
          >
            {creating ? strings.loading : strings.createTag}
          </button>
          {createError ? <p className="capture-error" role="alert">{createError}</p> : null}
        </form>
      </section>

      <div className="field tag-manager-search">
        <label htmlFor="tag-catalogue-search">{strings.searchTags}</label>
        <input
          id="tag-catalogue-search"
          type="search"
          placeholder={strings.searchTagsPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {allTags.length === 0 ? (
        <p className="text-muted">{strings.tagCatalogueEmpty}</p>
      ) : visibleTags.length === 0 ? (
        <p className="text-muted">{strings.noMatchingTags}</p>
      ) : (
        tagKinds.map((kind) => {
          const kindTags = visibleTags.filter((tag) => tag.kind === kind);
          if (foldedQuery && kindTags.length === 0) return null;
          const pinned = orderedPinnedTags(allTags, kind, locale);
          return (
            <CollapsibleGroup
              key={kind}
              title={`${strings.tagKindLabels[kind]} (${kindTags.length})`}
              headingLevel={2}
            >
              <div className="tag-manager-list">
                {kindTags.length === 0 ? (
                  <p className="text-muted tag-manager-empty">{strings.noTagsOfType}</p>
                ) : kindTags.map((tag) => {
                  const pinnedIndex = pinned.findIndex((candidate) => candidate.id === tag.id);
                  const busy = updatingId !== null;
                  return (
                    <article key={tag.id} className="tag-manager-row" aria-busy={updatingId === tag.id}>
                      <div className="tag-manager-row-main">
                        <span
                          className="tag-manager-color"
                          style={{ "--tag-color": tag.color } as CSSProperties}
                          aria-hidden="true"
                        />
                        <span>
                          <strong>{tag.name}</strong>
                          {tag.groupingMode === "pinned" ? (
                            <small className="tag-manager-meta">{strings.preferredForGrouping}</small>
                          ) : null}
                        </span>
                      </div>
                      <div className="tag-manager-row-actions">
                        {tag.groupingMode === "pinned" ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`${strings.increaseTagPriority}: ${tag.name}`}
                              disabled={busy || pinnedIndex <= 0}
                              onClick={() => void movePinned(tag, -1)}
                            >
                              {strings.priorityUp}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`${strings.decreaseTagPriority}: ${tag.name}`}
                              disabled={busy || pinnedIndex === pinned.length - 1}
                              onClick={() => void movePinned(tag, 1)}
                            >
                              {strings.priorityDown}
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => startEditing(tag)}
                        >
                          {strings.edit}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </CollapsibleGroup>
          );
        })
      )}
      {actionError ? <p className="capture-error" role="alert">{actionError}</p> : null}

      {editing ? (
        <BottomSheet
          title={`${strings.editTag}: ${editing.name}`}
          onClose={closeEditor}
          labelledBy="edit-tag-title"
        >
          <form className="stack" onSubmit={(event) => void save(event)}>
            <div className="field">
              <label htmlFor="edit-tag-name">{strings.tagName}</label>
              <input
                id="edit-tag-name"
                autoFocus
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </div>
            <div className="list-option-field">
              <span className="list-option-label">{strings.tagKind}</span>
              <div className="list-option-group" role="group" aria-label={strings.editTagType}>
                {tagKinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="list-option-button"
                    aria-pressed={editKind === kind}
                    disabled={saving || deleting}
                    onClick={() => setEditKind(kind)}
                  >
                    {strings.tagKindLabels[kind]}
                  </button>
                ))}
              </div>
            </div>
            <div className="list-option-field">
              <span className="list-option-label">{strings.groupingPreference}</span>
              <p className="text-muted tag-manager-hint">{strings.groupingPreferenceHint}</p>
              <div className="list-option-group" role="group" aria-label={strings.groupingPreference}>
                <button
                  type="button"
                  className="list-option-button"
                  aria-pressed={!editPreferred}
                  disabled={saving || deleting}
                  onClick={() => setEditPreferred(false)}
                >
                  {strings.standardGrouping}
                </button>
                <button
                  type="button"
                  className="list-option-button"
                  aria-pressed={editPreferred}
                  disabled={saving || deleting}
                  onClick={() => setEditPreferred(true)}
                >
                  {strings.preferredForGrouping}
                </button>
              </div>
            </div>
            {editorError ? <p className="capture-error" role="alert">{editorError}</p> : null}
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={saving || deleting}
                onClick={closeEditor}
              >
                {strings.cancel}
              </button>
              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={saving || deleting || !editName.trim()}
              >
                {saving ? strings.loading : strings.save}
              </button>
            </div>
            <div className="tag-manager-danger">
              {confirmingDelete ? (
                <>
                  <strong>{strings.deleteTagTitle(editing.name)}</strong>
                  <p className="text-muted">{strings.deleteTagWarning}</p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      disabled={deleting}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      {strings.cancel}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={deleting}
                      onClick={() => void remove()}
                    >
                      {deleting ? strings.loading : strings.deleteTag}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={saving}
                  onClick={() => setConfirmingDelete(true)}
                >
                  {strings.deleteTag}
                </button>
              )}
            </div>
          </form>
        </BottomSheet>
      ) : null}
    </div>
  );
}

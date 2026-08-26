import { useState, type FormEvent } from "react";
import {
  tagGroupingModes,
  tagKinds,
  type Tag,
  type TagGroupingMode,
  type TagKind,
} from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { ErrorState, LoadingState } from "./AsyncStates";
import { TagChip } from "./TagChip";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TagManager() {
  const { data: tags, loading, error, reload } = useAsync(() => api.getTags(), []);
  const { bump } = useRefresh();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      await api.createTag(trimmed);
      setName("");
      reload();
      bump();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (tag: Tag) => {
    if (!window.confirm(strings.tagDeleteConfirm(tag.name))) return;
    setDeletingId(tag.id);
    setActionError(null);
    try {
      await api.deleteTag(tag.id);
      reload();
      bump();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setDeletingId(null);
    }
  };

  const update = async (
    tag: Tag,
    patch: Parameters<typeof api.updateTag>[1],
  ) => {
    setUpdatingId(tag.id);
    setActionError(null);
    try {
      await api.updateTag(tag.id, patch);
      reload();
      bump();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setUpdatingId(null);
    }
  };

  const movePinned = async (tag: Tag, direction: -1 | 1) => {
    const ordered = (tags ?? [])
      .filter(
        (candidate) =>
          candidate.kind === tag.kind &&
          candidate.groupingMode === "pinned",
      )
      .sort(
        (a, b) =>
          (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
            (b.sortPosition ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name, "de") ||
          a.id - b.id,
      );
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
      setActionError(errorMessage(cause));
    } finally {
      setUpdatingId(null);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="stack">
      {tagKinds.map((kind) => {
        const kindTags = (tags ?? []).filter((tag) => tag.kind === kind);
        if (kindTags.length === 0) return null;
        return (
          <section key={kind} className="stack">
            <h3>{strings.tagKindLabels[kind]}</h3>
            {kindTags.map((tag) => {
              const pinned = kindTags
                .filter((candidate) => candidate.groupingMode === "pinned")
                .sort(
                  (a, b) =>
                    (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
                      (b.sortPosition ?? Number.MAX_SAFE_INTEGER) ||
                    a.name.localeCompare(b.name, "de") ||
                    a.id - b.id,
                );
              const pinnedIndex = pinned.findIndex(
                (candidate) => candidate.id === tag.id,
              );
              const busy =
                deletingId === tag.id || updatingId === tag.id;
              return (
                <article key={tag.id} className="card stack" aria-busy={busy}>
                  <TagChip
                    tag={tag}
                    disabled={deletingId !== null || updatingId !== null}
                    onRemove={() => void remove(tag)}
                  />
                  <div className="row" role="group" aria-label={`${tag.name}: ${strings.tagKind}`}>
                    {tagKinds.map((nextKind: TagKind) => (
                      <button
                        key={nextKind}
                        type="button"
                        className="chip"
                        aria-pressed={tag.kind === nextKind}
                        disabled={busy}
                        onClick={() => void update(tag, { kind: nextKind })}
                      >
                        {strings.tagKindLabels[nextKind]}
                      </button>
                    ))}
                  </div>
                  <div className="row" role="group" aria-label={`${tag.name}: ${strings.tagGroupingMode}`}>
                    {tagGroupingModes.map((mode: TagGroupingMode) => (
                      <button
                        key={mode}
                        type="button"
                        className="chip"
                        aria-pressed={tag.groupingMode === mode}
                        disabled={busy}
                        onClick={() =>
                          void update(tag, {
                            groupingMode: mode,
                            sortPosition:
                              mode === "pinned"
                                ? tag.sortPosition ?? pinned.length
                                : null,
                          })
                        }
                      >
                        {strings.tagGroupingModeLabels[mode]}
                      </button>
                    ))}
                  </div>
                  {tag.groupingMode === "pinned" ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`${strings.moveTagUp}: ${tag.name}`}
                        disabled={busy || pinnedIndex <= 0}
                        onClick={() => void movePinned(tag, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`${strings.moveTagDown}: ${tag.name}`}
                        disabled={busy || pinnedIndex < 0 || pinnedIndex === pinned.length - 1}
                        onClick={() => void movePinned(tag, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        );
      })}
      <form className="tag-create" onSubmit={(event) => void create(event)}>
        <input
          aria-label={strings.newTag}
          placeholder={strings.newTagPlaceholder}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={creating || !name.trim()}>
          {creating ? strings.loading : strings.createTag}
        </button>
      </form>
      {actionError ? <p className="text-muted" role="alert">{actionError}</p> : null}
    </div>
  );
}

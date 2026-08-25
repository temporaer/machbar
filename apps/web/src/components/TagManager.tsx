import { useState, type FormEvent } from "react";
import type { Tag } from "@machbar/shared";
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

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="stack">
      <div className="tag-choice-group">
        {(tags ?? []).map((tag) => (
          <span key={tag.id} aria-busy={deletingId === tag.id}>
            <TagChip
              tag={tag}
              disabled={deletingId !== null}
              onRemove={() => void remove(tag)}
            />
          </span>
        ))}
      </div>
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

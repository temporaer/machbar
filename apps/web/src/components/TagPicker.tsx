import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { tagKinds, type Tag, type TagKind } from "@machbar/shared";
import { api } from "../lib/api";
import { strings } from "../lib/strings";

export function TagPicker({
  tags,
  selectedIds,
  hiddenIds = [],
  onChange,
  defaultKind = "plain",
  kinds = tagKinds,
}: {
  tags: Tag[];
  selectedIds: number[];
  hiddenIds?: number[];
  onChange: (ids: number[]) => void | Promise<void>;
  defaultKind?: TagKind;
  kinds?: readonly TagKind[];
}) {
  const [availableTags, setAvailableTags] = useState(tags);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<TagKind>(defaultKind);

  useEffect(() => {
    setAvailableTags((current) => {
      const merged = new Map(current.map((tag) => [tag.id, tag]));
      for (const tag of tags) merged.set(tag.id, tag);
      return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
    });
  }, [tags]);

  const hidden = new Set(hiddenIds);
  const visibleTags = availableTags.filter(
    (tag) => !hidden.has(tag.id) && kinds.includes(tag.kind),
  );

  const toggle = (tagId: number) => {
    const next = selectedIds.includes(tagId)
      ? selectedIds.filter((id) => id !== tagId)
      : [...selectedIds, tagId];
    void onChange(next);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const tag = await api.createTag(trimmed, createKind);
      setAvailableTags((current) =>
        [...new Map([...current, tag].map((item) => [item.id, item])).values()].sort((a, b) =>
          a.name.localeCompare(b.name, "de"),
        ),
      );
      setName("");
      if (!selectedIds.includes(tag.id)) await onChange([...selectedIds, tag.id]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : strings.error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="tag-picker">
      <div className="tag-choice-group" role="group" aria-label={strings.tags}>
        {kinds.map((kind) => (
          <section className="tag-kind-section" key={kind}>
            <p className="text-muted tag-kind-label">{strings.tagKindLabels[kind]}</p>
            <div className="tag-choice-group">
              {visibleTags
                .filter((tag) => tag.kind === kind)
                .map((tag) => {
                  const selected = selectedIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className="tag-choice"
                      aria-pressed={selected}
                      style={{ "--tag-color": tag.color } as CSSProperties}
                      onClick={() => toggle(tag.id)}
                    >
                      <span className="tag-color-dot" aria-hidden="true" />
                      {tag.name}
                    </button>
                  );
                })}
            </div>
          </section>
        ))}
      </div>
      <form className="tag-create" onSubmit={(event) => void create(event)}>
        <div className="row" role="group" aria-label={strings.tagKind}>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="chip"
              aria-pressed={createKind === kind}
              onClick={() => setCreateKind(kind)}
            >
              {strings.tagKindLabels[kind]}
            </button>
          ))}
        </div>
        <input
          aria-label={`${strings.newTag}: ${strings.tagKindLabels[createKind]}`}
          placeholder={strings.newTagPlaceholder}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn btn-small" disabled={!name.trim() || creating}>
          {creating ? strings.loading : strings.createTag}
        </button>
      </form>
      {error ? <div className="error" role="alert">{error}</div> : null}
    </div>
  );
}

import type { CSSProperties } from "react";
import { tagKinds, type Tag, type TagKind } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";

export function TagPicker({
  tags,
  selectedIds,
  hiddenIds = [],
  onChange,
  kinds = tagKinds,
}: {
  tags: Tag[];
  selectedIds: number[];
  hiddenIds?: number[];
  onChange: (ids: number[]) => void | Promise<void>;
  kinds?: readonly TagKind[];
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const hidden = new Set(hiddenIds);
  const visibleTags = tags
    .filter((tag) => !hidden.has(tag.id) && kinds.includes(tag.kind))
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  const toggle = (tagId: number) => {
    const next = selectedIds.includes(tagId)
      ? selectedIds.filter((id) => id !== tagId)
      : [...selectedIds, tagId];
    void onChange(next);
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
    </div>
  );
}

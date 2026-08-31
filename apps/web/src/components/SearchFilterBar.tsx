import { useState, type CSSProperties } from "react";
import type { Project, SearchFilters, Tag, TaskStatus } from "@machbar/shared";
import { tagKinds, taskStatuses } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { HumanDateInput } from "./HumanDateInput";
import { useIdentity } from "../lib/identity";
import { MemberChoiceGroup } from "./MemberChoiceGroup";
import { useLocale } from "../lib/locale";
import { sortProjectsByTitle } from "../lib/sortOrder";

export function SearchFilterBar({
  filters,
  onChange,
  projects,
  tags,
}: {
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  projects: Project[];
  tags: Tag[];
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const { members } = useIdentity();
  const [expanded, setExpanded] = useState(false);

  const set = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    onChange({ ...filters, [key]: value || undefined });
  };

  const toggleTag = (id: number) => {
    const current = filters.tagIds ?? [];
    const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
    const updated: SearchFilters = { ...filters };
    if (next.length) updated.tagIds = next;
    else delete updated.tagIds;
    onChange(updated);
  };

  return (
    <div className="stack">
      <input
        aria-label={strings.search}
        placeholder={strings.searchPlaceholder}
        value={filters.text ?? ""}
        onChange={(e) => set("text", e.target.value)}
      />
      <div className="row-between">
        <button
          type="button"
          className="btn btn-sm disclosure-button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>{strings.filters}</span>
          <span className="disclosure-button-chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange({})}>
          {strings.resetFilters}
        </button>
      </div>
      {expanded ? (
        <div className="stack">
          <MemberChoiceGroup
            label={strings.owner}
            idPrefix="filter-owner"
            members={members}
            value={filters.ownerId ?? null}
            onChange={(ownerId) => set("ownerId", ownerId ?? undefined)}
            unassignedLabel={strings.allMembers}
          />
          <div className="field">
            <label htmlFor="filter-project">{strings.project}</label>
            <select
              id="filter-project"
              value={filters.projectId ?? ""}
              onChange={(e) => set("projectId", e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">{strings.allProjects}</option>
              {sortProjectsByTitle(projects, locale).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-status">{strings.status}</label>
            <select
              id="filter-status"
              value={filters.status ?? ""}
              onChange={(e) => set("status", (e.target.value || undefined) as TaskStatus | undefined)}
            >
              <option value="">{strings.allStatuses}</option>
              {taskStatuses.map((s) => (
                <option key={s} value={s}>
                  {strings.taskStatusLabels[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="filter-due-from">{strings.dueFrom}</label>
              <HumanDateInput
                id="filter-due-from"
                value={filters.dueFrom ?? ""}
                onChange={(date) => set("dueFrom", date ?? undefined)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="filter-due-to">{strings.dueTo}</label>
              <HumanDateInput
                id="filter-due-to"
                value={filters.dueTo ?? ""}
                onChange={(date) => set("dueTo", date ?? undefined)}
              />
            </div>
          </div>
          {tags.length > 0 ? (
            <div className="field">
              <label>{strings.tags}</label>
              {tagKinds.map((kind) => (
                <div key={kind}>
                  <p className="text-muted">{strings.tagKindLabels[kind]}</p>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {tags
                      .filter((tag) => tag.kind === kind)
                      .map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          className="tag-choice"
                          aria-pressed={(filters.tagIds ?? []).includes(tag.id)}
                          style={{ "--tag-color": tag.color } as CSSProperties}
                          onClick={() => toggleTag(tag.id)}
                        >
                          <span className="tag-color-dot" aria-hidden="true" />
                          {tag.name}
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

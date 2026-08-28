import { useId, useMemo, useState } from "react";
import { useStrings } from "../lib/strings";
import { pickRecent, type DestinationKind } from "../lib/recentDestinations";
import { useLocale } from "../lib/locale";

export interface DestinationOption {
  id: number;
  title: string;
  /**
   * Secondary line, also searched. For parent-task candidates this is the
   * owning project's title, so typing a project name finds its tasks too.
   */
  subtitle?: string | null;
}

function matches(
  option: DestinationOption,
  needle: string,
  locale: string,
): boolean {
  if (!needle) return true;
  const haystack = `${option.title} ${
    option.subtitle ?? ""
  }`.toLocaleLowerCase(locale);
  return haystack.includes(needle);
}

/**
 * Searchable destination list used by every refile/move picker.
 *
 * A `<select>` is fine with three projects and unusable with thirty: the
 * native picker has no search, and on a phone it covers the sheet that
 * explains what is being moved. This renders an always-visible filter plus
 * full-width tap rows, so a destination is at most "type two letters, tap".
 *
 * With an empty query the recently used destinations are listed first
 * (`lib/recentDestinations`), because refiling is repetitive — the same few
 * projects absorb most moves. Recents that are no longer offered (archived,
 * deleted, or excluded by the caller's subtree/cycle rules) are dropped
 * silently, so the shortcut can never propose an illegal target.
 *
 * The component only *selects*; the caller still submits through the API,
 * which keeps enforcing hierarchy/cycle validation server-side.
 */
export function DestinationPicker({
  kind,
  label,
  options,
  value,
  onChange,
  noneLabel,
  autoFocus = false,
}: {
  kind: DestinationKind;
  /** Visible + accessible name of the picker, e.g. "Projekt wählen". */
  label: string;
  options: DestinationOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** Label of the always-available "no destination" row (top level / inbox). */
  noneLabel: string;
  /** Focus the search field when a picker is the immediate next capture step. */
  autoFocus?: boolean;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const reactId = useId();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase(locale);

  const recents = useMemo(
    () =>
      pickRecent(kind, options).filter((option) =>
        matches(option, needle, locale),
      ),
    [kind, locale, options, needle],
  );

  const rest = useMemo(() => {
    const recentIds = new Set(recents.map((option) => option.id));
    return options.filter(
      (option) =>
        !recentIds.has(option.id) && matches(option, needle, locale),
    );
  }, [locale, options, recents, needle]);

  const noneVisible =
    !needle || noneLabel.toLocaleLowerCase(locale).includes(needle);
  const nothingToShow = !noneVisible && recents.length === 0 && rest.length === 0;

  const row = (id: number | null, title: string, subtitle?: string | null) => (
    <button
      key={id ?? "none"}
      type="button"
      className="destination-row"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
    >
      <span className="destination-row-title">{title}</span>
      {subtitle ? <span className="destination-row-subtitle">{subtitle}</span> : null}
    </button>
  );

  return (
    <div className="field">
      <label htmlFor={`${reactId}-search`}>{label}</label>
      <input
        id={`${reactId}-search`}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={strings.searchDestinationPlaceholder}
        aria-label={strings.searchDestination}
        autoFocus={autoFocus}
        autoComplete="off"
      />

      <div className="destination-list">
        {noneVisible ? (
          <div role="group" aria-label={noneLabel}>
            {row(null, noneLabel)}
          </div>
        ) : null}

        {recents.length > 0 ? (
          <div role="group" aria-label={strings.recentDestinations}>
            <p className="text-muted destination-group-label">{strings.recentDestinations}</p>
            {recents.map((option) => row(option.id, option.title, option.subtitle))}
          </div>
        ) : null}

        {rest.length > 0 ? (
          <div
            role="group"
            aria-label={recents.length > 0 ? strings.allDestinations : label}
          >
            {recents.length > 0 ? (
              <p className="text-muted destination-group-label">{strings.allDestinations}</p>
            ) : null}
            {rest.map((option) => row(option.id, option.title, option.subtitle))}
          </div>
        ) : null}

        {nothingToShow ? (
          <p className="text-muted">{strings.destinationSearchEmpty}</p>
        ) : null}
      </div>
    </div>
  );
}

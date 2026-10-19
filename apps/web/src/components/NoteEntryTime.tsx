import { useLocale } from "../lib/locale";
import { useHouseholdTimezone } from "../lib/householdTimezone";
export function NoteEntryTime({
  instant,
  author,
}: {
  instant: string;
  author?: string | undefined;
}) {
  const { locale } = useLocale();
  const { timezone } = useHouseholdTimezone();
  return (
    <small className="note-entry-time">
      <time dateTime={instant} title={instant}>
        {new Intl.DateTimeFormat(locale, {
          timeZone: timezone,
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(instant))}
      </time>
      {author ? ` · ${author}` : ""}
    </small>
  );
}

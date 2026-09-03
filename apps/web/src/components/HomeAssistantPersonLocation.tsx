import type { HomeAssistantPerson } from "@machbar/shared";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";

export function HomeAssistantPersonLocation({
  person,
  stale,
  showObservedAt = false,
}: {
  person: HomeAssistantPerson;
  stale: boolean;
  showObservedAt?: boolean;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const location =
    person.state === "unknown"
      ? strings.homeAssistantLocationUnknown
      : person.contexts.length === 0
        ? strings.homeAssistantNoKnownLocation
        : (stale
            ? strings.homeAssistantLastKnownLocation
            : strings.homeAssistantCurrentLocation)(
            person.contexts.map((context) => context.name).join(", "),
          );

  return (
    <small className="text-muted">
      {location}
      {showObservedAt ? (
        <>
          {" · "}
          {strings.homeAssistantObservedAt(
            new Date(person.observedAt).toLocaleString(locale),
          )}
        </>
      ) : null}
    </small>
  );
}

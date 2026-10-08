import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";

function supportedTimezones(): string[] {
  const values =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return values.length > 0 ? values : ["Europe/Berlin", "UTC", "America/New_York"];
}

export function HouseholdTimezoneSetting() {
  const strings = useStrings();
  const { data, loading, error, refreshError, reload } = useAsync(
    () => api.getHouseholdTimezone(),
    [],
  );
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const options = useMemo(supportedTimezones, []);

  useEffect(() => {
    if (data) setTimezone(data.timezone);
  }, [data]);

  const commit = async (nextTimezone: string) => {
    setTimezone(nextTimezone);
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateHouseholdTimezone(nextTimezone);
      reload();
    } catch (cause) {
      setSaveError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card more-setting-card">
      <h3>{strings.householdTimezone}</h3>
      <p className="text-muted">{strings.householdTimezoneHint}</p>
      {loading && !data ? <p className="text-muted">…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {data ? (
        <div className="field">
          <label htmlFor="household-timezone">{strings.householdTimezone}</label>
          <select
            id="household-timezone"
            value={timezone}
            disabled={saving}
            onChange={(event) => void commit(event.target.value)}
          >
            {!options.includes(timezone) ? (
              <option value={timezone}>{timezone}</option>
            ) : null}
            {options.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {refreshError || saveError ? (
        <p className="text-muted" role="alert">
          {saveError ?? refreshError}
        </p>
      ) : null}
    </div>
  );
}

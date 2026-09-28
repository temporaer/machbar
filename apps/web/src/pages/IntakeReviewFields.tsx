import { useCallback, useEffect, useRef, useState } from "react";
import type { IntakeIssue } from "@machbar/shared";
import { issuesForPath } from "../lib/intakeDraft";
import { taskAvailabilityClock } from "../lib/taskAvailability";
import { localDateForInstant, localDateTimeToIso } from "../lib/localDateTime";
import { useStrings } from "../lib/strings";
import { HumanDateInput } from "../components/HumanDateInput";
import { ClockTimePicker } from "../components/ClockTimePicker";

export type DateValidityChange = (key: string, valid: boolean) => void;

export function useDateValidityCallback(
  key: string,
  onDateValidityChange: DateValidityChange,
) {
  const initialValid = useRef(true);
  return useCallback(
    (valid: boolean) => {
      if (initialValid.current && valid) {
        initialValid.current = false;
        return;
      }
      initialValid.current = false;
      onDateValidityChange(key, valid);
    },
    [key, onDateValidityChange],
  );
}

export function IntakeIssueText({
  issues,
  path,
}: {
  issues: IntakeIssue[];
  path: (string | number)[];
}) {
  return issuesForPath(issues, path).map((issue, index) => (
    <small className="field-error" role="alert" key={`${issue.code}-${index}`}>
      {issue.message}
    </small>
  ));
}

export function IntakeLocalDateTimeField({
  id,
  fieldKey,
  label,
  value,
  onDateValidityChange,
  onChange,
}: {
  id: string;
  fieldKey: string;
  label: string;
  value: string | null;
  onDateValidityChange: DateValidityChange;
  onChange: (value: string | null) => void;
}) {
  const strings = useStrings();
  const onValidityChange = useDateValidityCallback(
    fieldKey,
    onDateValidityChange,
  );
  const [date, setDate] = useState(() =>
    value ? localDateForInstant(value) ?? "" : "",
  );
  const [time, setTime] = useState(() =>
    value ? taskAvailabilityClock(value) ?? "" : "",
  );

  useEffect(() => {
    setDate(value ? localDateForInstant(value) ?? "" : "");
    setTime(value ? taskAvailabilityClock(value) ?? "" : "");
  }, [value]);

  const commit = (nextDate: string, nextTime: string) => {
    if (!nextDate || !nextTime) {
      if (value) onChange(null);
      return;
    }
    const nextValue = localDateTimeToIso(nextDate, nextTime);
    if (nextValue && nextValue !== value) onChange(nextValue);
  };

  return (
    <>
      <label htmlFor={`${id}-date`}>{label}</label>
      <HumanDateInput
        id={`${id}-date`}
        value={date}
        onValidityChange={onValidityChange}
        onChange={(next) => {
          const nextDate = next ?? "";
          setDate(nextDate);
          commit(nextDate, time);
        }}
      />
      <label htmlFor={`${id}-time`}>{strings.availabilityCustomTime}</label>
      <ClockTimePicker
        id={`${id}-time`}
        value={time}
        onChange={(next) => {
          setTime(next);
          commit(date, next);
        }}
      />
    </>
  );
}

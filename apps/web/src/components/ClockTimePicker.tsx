import { Timepicker } from "timepicker-ui-react";
import "timepicker-ui/main.css";
import { useStrings } from "../lib/strings";
import "./ClockTimePicker.css";

/**
 * Machbar's wrapper around `timepicker-ui-react`'s `Timepicker` so the
 * third-party component's own props/styling never leak through the
 * application. Callers only see a Machbar-shaped time-only control:
 * a controlled `"HH:mm"` string in, an `"HH:mm"` string out.
 *
 * Uses the analog clock face (Material/Google-style interaction: tap/drag
 * the hour hand, it auto-switches to minutes, tap/drag the minute hand,
 * confirm) in 24-hour mode. `timepicker-ui` always reports zero-padded
 * `hour`/`minutes` strings, so building `"HH:mm"` from them needs no
 * further padding.
 */
export function ClockTimePicker({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (hhmm: string) => void;
  disabled?: boolean;
}) {
  const strings = useStrings();

  return (
    <Timepicker
      id={id}
      className="clock-time-picker-input"
      value={value}
      disabled={disabled}
      options={{
        clock: {
          type: "24h",
          autoSwitchToMinutes: true,
          incrementMinutes: 5,
        },
        ui: {
          mode: "clock",
          theme: "basic",
          animation: true,
        },
        labels: {
          ok: strings.confirmDone,
          cancel: strings.cancel,
        },
      }}
      onConfirm={(data) => {
        if (!data.hour || !data.minutes) return;
        onChange(`${data.hour}:${data.minutes}`);
      }}
    />
  );
}

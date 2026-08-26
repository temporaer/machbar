import { strings } from "../lib/strings";

export const scheduleShortcuts = ["tomorrow", "nextWeek", "weekend"] as const;
export type ScheduleShortcut = (typeof scheduleShortcuts)[number];

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveScheduleShortcut(shortcut: ScheduleShortcut, today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (shortcut === "tomorrow") {
    date.setDate(date.getDate() + 1);
  } else if (shortcut === "nextWeek") {
    const daysUntilNextMonday = ((8 - date.getDay()) % 7) || 7;
    date.setDate(date.getDate() + daysUntilNextMonday);
  } else {
    const daysUntilSaturday = (6 - date.getDay() + 7) % 7;
    date.setDate(date.getDate() + daysUntilSaturday);
  }

  return localDateString(date);
}

export function ScheduleShortcuts({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (date: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="choice-group" role="group" aria-label={strings.scheduleShortcuts}>
      {scheduleShortcuts.map((shortcut) => {
        const date = resolveScheduleShortcut(shortcut);
        return (
          <button
            key={shortcut}
            type="button"
            className="choice-chip"
            aria-pressed={value === date}
            disabled={disabled}
            onClick={() => onChange(date)}
          >
            {strings.scheduleShortcutLabels[shortcut]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The browser's IANA timezone, used both to register a push subscription's
 * timezone (`pushNotifications.ts`) and to capture the timezone a
 * deadline-relative reminder's local wall-clock time is resolved against
 * (`reminderPresets.ts`/`TaskRemindersSheet.tsx`). Centralised so both
 * call sites derive it the same way instead of inventing separate sources.
 */
export function browserTimezone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

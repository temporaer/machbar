import type { Strings } from "./strings";

const MAX_INVALID_VALUE_PREVIEW_LENGTH = 80;

export function formatInvalidIntakeValue(value: string, strings: Pick<Strings, "invalidDate">): string {
  const preview =
    value.length > MAX_INVALID_VALUE_PREVIEW_LENGTH
      ? `${value.slice(0, MAX_INVALID_VALUE_PREVIEW_LENGTH - 3)}...`
      : value;
  return `${strings.invalidDate}: ${preview}`;
}

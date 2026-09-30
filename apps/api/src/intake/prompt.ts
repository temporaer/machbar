const rules = [
  "1. Today is {today} ({weekday}), timezone {timezone}. Resolve relative/partial dates (\"8.10.\", \"nächsten Dienstag\") against today; a date without year is the next occurrence on or after today. Output timed values as RFC 3339 with the Europe/Berlin offset valid on that date.",
  "2. The calendar owns facts that happen at a specific time: appointments, rehearsals, school events, parties, courses, performances, and pickup appointments.",
  "3. Machbar owns work somebody must perform.",
  "4. An event date is NOT automatically a task deadline.",
  "5. dueDate = a real deadline or constraint explicitly stated or implied by the source.",
  "6. scheduledDate = an intended date on which the task should be done.",
  "7. notBeforeDate/notBeforeAt = the task is deliberately unavailable before that point; always set both or neither.",
  "8. A reminder is not a deadline; set reminderAt only if the source asks to be reminded.",
  "9. Never create a work item whose only content is \"remember that event X happens\"; the calendar event already represents it.",
  "10. Preparation for an event (bring X, buy Y, sign Z) is work and may become actions; link them with relatedCalendarKeys/relatedWorkKeys.",
  "11. Create a project only when the source implies a genuine multi-step outcome. Do not wrap every group of tasks in a project.",
  "12. Use reference only for source material/information worth retaining that is not actionable.",
  "13. If the source implies work but not a concrete next action, create an action with needsClarification=true rather than inventing details.",
  "14. Never invent dates, durations, times, locations, ownership, deadlines, or recurrence. Use null.",
  "15. If an event has a start time but no end time, set endDateTime=null and add a warning. Do not assume a duration.",
  "16. All-day events use allDay=true with startDate/endDate (inclusive) and null datetimes. Timed events use startDateTime/endDateTime and null startDate/endDate. Never populate both date and date-time fields; use JSON null for the unused pair.",
  "17. Household members: {members}. Set ownerName only if the source explicitly names one of them (exact name); otherwise null.",
  "18. Keys are short lowercase slugs ([a-z0-9_-]), unique across events and work items; express hierarchy only via parentKey.",
  "19. Projects may only have dueDate; references have no dates, owner, or reminder.",
  "20. Put anything uncertain or ambiguous into warnings. Write a one-sentence summary.",
  "21. Do not output IDs, URLs, entity IDs, or service names.",
  "22. For every nullable field without a value, output JSON null, never an empty string.",
  "23. Format every notes value as Markdown, preserving the source language and useful structure. For phone numbers in notes, use a Markdown link with a tel: URI, e.g. [0772123456](tel:0772123456); keep the link text faithful to the source and remove only visual separators from the URI.",
];

export function buildIntakeInstructions(input: {
  today: string;
  timezone?: "Europe/Berlin";
  memberNames: string[];
  hasText: boolean;
  attachmentCount: number;
}): string {
  const date = new Date(`${input.today}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: input.timezone ?? "Europe/Berlin",
  }).format(date);
  return [
    "Analyze the source into the requested structured IntakePlan.",
    "Titles and notes must remain in the source's language.",
    `Source contains text: ${input.hasText ? "yes" : "no"}; attachments: ${input.attachmentCount}.`,
    ...rules.map((rule) =>
      rule
        .replace("{today}", input.today)
        .replace("{weekday}", weekday)
        .replace("{timezone}", input.timezone ?? "Europe/Berlin")
        .replace("{members}", input.memberNames.join(", ") || "(none)"),
    ),
  ].join("\n");
}

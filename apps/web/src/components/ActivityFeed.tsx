import type { ActivityEvent } from "@machbar/shared";
import { activityDateGroup } from "../lib/activityFormatting";
import { ActivityEventRow } from "./ActivityEventRow";

export function ActivityFeed({
  events,
  now = new Date(),
  headingLevel = 2,
  idPrefix = "activity",
}: {
  events: ActivityEvent[];
  now?: Date;
  headingLevel?: 2 | 3;
  idPrefix?: string;
}) {
  const groups: Array<{ key: string; label: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const group = activityDateGroup(event.createdAt, now);
    const current = groups.at(-1);
    if (current?.key === group.key) {
      current.events.push(event);
    } else {
      groups.push({ ...group, events: [event] });
    }
  }

  return (
    <div className="activity-feed">
      {groups.map((group) => (
        <section className="activity-group" key={group.key} aria-labelledby={`${idPrefix}-${group.key}`}>
          <div
            className="section-title"
            id={`${idPrefix}-${group.key}`}
            role="heading"
            aria-level={headingLevel}
          >
            {group.label}
          </div>
          <ul className="activity-event-list">
            {group.events.map((event) => (
              <ActivityEventRow key={event.id} event={event} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

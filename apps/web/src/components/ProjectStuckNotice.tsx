import type { StuckReason } from "@machbar/shared";
import { strings, stuckReasonLabels } from "../lib/strings";

export function ProjectStuckNotice({ reason }: { reason: StuckReason }) {
  return (
    <section className="project-stuck-panel" aria-labelledby="project-stuck-heading">
      <div>
        <h2 id="project-stuck-heading">{strings.stuckProjectHeading}</h2>
        <span className="badge badge-stuck">{stuckReasonLabels[reason]}</span>
      </div>
      <p>{strings.stuckRepairLabels[reason]}</p>
    </section>
  );
}

import type { StuckReason } from "@machbar/shared";
import { useStrings } from "../lib/strings";

export function ProjectStuckNotice({ reason }: { reason: StuckReason }) {
  const strings = useStrings();
  return (
    <section className="project-stuck-panel" aria-labelledby="project-stuck-heading">
      <div>
        <h2 id="project-stuck-heading">{strings.stuckProjectHeading}</h2>
        <span className="badge badge-stuck">{strings.stuckReasonLabels[reason]}</span>
      </div>
      <p>{strings.stuckRepairLabels[reason]}</p>
    </section>
  );
}

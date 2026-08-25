import type { WaitingGroup } from "@machbar/shared";
import { strings } from "../lib/strings";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { EmptyState } from "./AsyncStates";
import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/format";
import { useState } from "react";
import { WaitingFollowUpSheet } from "./WaitingFollowUpSheet";

export function WaitingGroupList({ groups }: { groups: WaitingGroup[] }) {
  const { open } = useTaskDetail();
  const { bump } = useRefresh();
  const [followUpTask, setFollowUpTask] = useState<WaitingGroup["tasks"][number] | null>(null);

  if (groups.length === 0) return <EmptyState message={strings.waitingEmpty} />;

  return (
    <div className="stack">
      {groups.map((group) => (
        <div key={group.waitingFor} className="section">
          <div className="section-title">
            <span>
              {strings.followUpFor}: {group.waitingFor}
            </span>
          </div>
          <ul className="list" style={{ padding: 0, margin: 0 }}>
            {group.tasks.map((task) => (
              <li key={task.id} className="card">
                <div className="row-between">
                  <button type="button" className="link-plain" onClick={() => open(task.id)}>
                    {task.title}
                  </button>
                  <StatusBadge status={task.status} />
                </div>
                {task.dueDate ? (
                  <p className="text-muted" style={{ margin: "4px 0 0" }}>
                    {strings.due}: {formatDate(task.dueDate)}
                  </p>
                ) : null}
                <div className="row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setFollowUpTask(task)}>
                    {strings.followUp}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void api.updateTask(task.id, { status: "actionable" }).then(bump)}
                  >
                    {strings.makeActionable}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {followUpTask ? (
        <WaitingFollowUpSheet
          task={followUpTask}
          onClose={() => setFollowUpTask(null)}
        />
      ) : null}
    </div>
  );
}

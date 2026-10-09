import type { Task } from "@machbar/shared";
import { TaskPlanningSheet } from "./TaskPlanningSheet";

/** Compatibility export for existing task.plan callers and tests. */
export function TaskPlanSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  return <TaskPlanningSheet task={task} onClose={onClose} />;
}

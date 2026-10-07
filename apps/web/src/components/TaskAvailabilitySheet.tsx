import type { Task } from "@machbar/shared";
import { TaskPlanningSheet } from "./TaskPlanningSheet";

/** Compatibility export for existing availability callers. */
export function TaskAvailabilitySheet({ task, onClose }: { task: Task; onClose: () => void }) {
  return <TaskPlanningSheet task={task} onClose={onClose} focus="availability" />;
}

import { useRef, useState } from "react";
import type { Intervention, InterventionTaskPlan } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useGoalActions } from "../lib/useGoalActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { TaskRemindersEditor } from "./TaskRemindersEditor";

/** Authored task drafts reused by manual backing and reviewed coach proposals. */
export function InterventionTasksEditor({ tasks, onChange, onPendingChange, disabled = false }: { tasks: InterventionTaskPlan[]; onChange: (tasks: InterventionTaskPlan[]) => void; onPendingChange?: (pending: boolean) => void; disabled?: boolean }) {
  const pendingReminders = useRef<Record<string, boolean>>({});
  const reminderPending = (key: string, pending: boolean) => { pendingReminders.current[key] = pending; onPendingChange?.(tasks.some((task) => pendingReminders.current[task.key])); };
  const s = useStrings();
  const patch = (index: number, value: Partial<InterventionTaskPlan>) => onChange(tasks.map((t, i) => i === index ? { ...t, ...value } : t));
  return <fieldset className="stack" disabled={disabled}><legend>{s.interventionTasksTitle}</legend>
    <p className="text-muted">{s.interventionTasksHint}</p>
    {tasks.map((task, index) => <article className="card stack" key={task.key}>
      <label className="field">{s.title}<input required value={task.title} onChange={(e) => patch(index, { title: e.target.value })} /></label>
      <label className="field">{s.interventionStartDateLabel}<input type="date" value={task.scheduledDate ?? ""} onChange={(e) => onChange(tasks.map((t, i) => { if (i !== index) return t; const { scheduledDate: _date, ...rest } = t; return e.target.value ? { ...rest, scheduledDate: e.target.value } : rest; }))} /></label>
      <label className="field">{s.interventionTaskRepeat}<input type="number" min={1} value={task.repeatAfterDays ?? ""} onChange={(e) => onChange(tasks.map((t, i) => { if (i !== index) return t; const { repeatAfterDays: _repeat, allowedDeviationDays: _deviation, ...rest } = t; return e.target.value ? { ...rest, repeatAfterDays: Number(e.target.value), allowedDeviationDays: 0 } : rest; }))} /></label>
      <TaskRemindersEditor reminders={task.reminders ?? []} dueDate={task.dueDate ?? (task.repeatAfterDays ? task.scheduledDate ?? null : null)} onChange={(reminders) => patch(index, { reminders })} onPendingChange={(pending) => reminderPending(task.key, pending)} disabled={disabled} />
      <button type="button" className="btn btn-sm" onClick={() => { reminderPending(task.key, false); onChange(tasks.filter((_, i) => i !== index)); }}>{s.remove}</button>
    </article>)}
    <button type="button" className="btn" disabled={tasks.length >= 8} onClick={() => onChange([...tasks, { key: crypto.randomUUID(), title: "" }])}>{s.interventionTaskAdd}</button>
  </fieldset>;
}
export function InterventionTasksSheet({ intervention, onClose }: { intervention: Intervention; onClose: () => void }) {
  const s = useStrings(), actions = useGoalActions();
  const [tasks, setTasks] = useState<InterventionTaskPlan[]>([{ key: crypto.randomUUID(), title: intervention.commitment }]);
  const [reminderPending, setReminderPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => { try { setError(null); await actions.backIntervention(intervention, { tasks }); onClose(); } catch (e) { setError(localizedErrorMessage(e, s)); } };
  return <BottomSheet title={s.interventionTasksTitle} onClose={onClose}><div className="stack">
    <InterventionTasksEditor tasks={tasks} onChange={setTasks} onPendingChange={setReminderPending} disabled={actions.isPending(intervention.id)} />
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" className="btn btn-primary" disabled={reminderPending || !tasks.length || tasks.some((t) => !t.title.trim()) || actions.isPending(intervention.id)} onClick={() => void save()}>{s.interventionTaskCreate}</button>
  </div></BottomSheet>;
}

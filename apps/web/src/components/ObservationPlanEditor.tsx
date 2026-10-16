import type { ObservationPlan } from "@machbar/shared";
import { useStrings } from "../lib/strings";

/** Draft-only editor reused by manual authoring and reviewed coach proposals. */
export function ObservationPlanEditor({ value, onChange, disabled = false }: { value: ObservationPlan; onChange: (plan: ObservationPlan) => void; disabled?: boolean }) {
  const s = useStrings();
  return <fieldset className="stack" disabled={disabled}>
    <legend>{s.observationPlanLabel}</legend>
    <label className="field">{s.observationMethodLabel}<select value={value.method} onChange={(e) => onChange(e.target.value === "daily_report" ? { method: "daily_report", question: "", reference: "night", reportDayOffset: 1, availableAfter: "07:00", opportunityBased: false } : { method: e.target.value as "reflection" | "task_evidence" })}>
      <option value="reflection">{s.observationReflection}</option><option value="task_evidence">{s.observationTasks}</option><option value="daily_report">{s.observationDaily}</option>
    </select></label>
    {value.method === "daily_report" ? <>
      <label className="field">{s.observationQuestion}<input required maxLength={500} value={value.question} onChange={(e) => onChange({ ...value, question: e.target.value })} /></label>
      <label className="field">{s.observationTiming}<select value={`${value.reference}-${value.reportDayOffset}`} onChange={(e) => { const [reference, offset] = e.target.value.split("-"); onChange({ ...value, reference: reference as "day" | "night", reportDayOffset: Number(offset) as 0 | 1 }); }}>
        <option value="night-1">{s.observationNextMorning}</option><option value="day-0">{s.observationAfterWindow}</option><option value="day-1">{s.observationNextDay}</option>
      </select></label>
      <label className="field">{s.observationAvailableAfter}<input type="time" value={value.availableAfter} onChange={(e) => onChange({ ...value, availableAfter: e.target.value })} /></label>
      <label><input type="checkbox" checked={value.opportunityBased} onChange={(e) => onChange({ ...value, opportunityBased: e.target.checked })} /> {s.observationOpportunity}</label>
      <label className="field">{s.observationTarget}<input type="number" min={1} max={7} value={value.target?.successfulDays ?? ""} onChange={(e) => onChange(e.target.value ? { ...value, target: { successfulDays: Number(e.target.value), window: value.target?.window ?? "calendar_week", ...(value.target?.anchorDate ? { anchorDate: value.target.anchorDate } : {}) } } : (({ target: _target, ...rest }) => rest)(value))} /></label>
      {value.target ? <><label className="field">{s.observationTargetWindow}<select value={value.target.window} onChange={(e) => onChange({ ...value, target: { ...value.target!, window: e.target.value as "calendar_week" | "seven_days" } })}><option value="calendar_week">{s.observationCalendarWeek}</option><option value="seven_days">{s.observationSevenDays}</option></select></label>
      {value.target.window === "seven_days" ? <label className="field">{s.observationAnchor}<input type="date" required value={value.target.anchorDate ?? ""} onChange={(e) => onChange({ ...value, target: { ...value.target!, anchorDate: e.target.value } })} /></label> : null}</> : null}
    </> : null}
    <p className="text-muted">{s.observationPlanHint}</p>
  </fieldset>;
}

/** Read-only plan wording reused in proposal acceptance and historical evidence. */
export function ObservationPlanSummary({ plan }: { plan: ObservationPlan }) {
  const s = useStrings();
  if (plan.method !== "daily_report") return <p>{plan.method === "task_evidence" ? s.observationTasks : s.observationReflection}</p>;
  return <div><p>{plan.question}</p><p>{plan.reference === "night" ? s.observationNextMorning : plan.reportDayOffset === 1 ? s.observationNextDay : s.observationAfterWindow} · {plan.availableAfter}</p>{plan.target ? <p>{s.observationTarget}: {plan.target.successfulDays} · {plan.target.window === "calendar_week" ? s.observationCalendarWeek : s.observationSevenDays} {plan.target.anchorDate}</p> : null}</div>;
}

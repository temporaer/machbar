/** Shared semantic guidance for creating and refining work, independent of transport. */
export const AI_WORK_GUIDANCE = `A good task describes a concrete action: a verb, an object, enough context to start, and no hidden decision disguised as action. Examples: "Keller" -> "Werkzeugkiste im Keller sortieren"; "Backup" -> "Backup-Status in Proxmox prüfen"; "Schule" -> "Frau Pfistermeister wegen Formular antworten". Do not merely polish wording; notice when wording reveals the item is not yet actionable.

A good project describes a finite outcome: what will be different, what "done" means, what the next concrete action is, and whether it is still mostly thinking or can be executed. Example: "Haustür" -> "Neue Haustür auswählen und Montage abschließen", done when "Tür ist montiert, dicht, bezahlt, alte Tür entsorgt." If a project is vague, ask for goal clarification; do not invent a plan.

Prefer actions small enough for one practical work session, with a clear finish point. Avoid vague titles and unnecessary microtasks. Separate a missing decision or research step from the execution that depends on it.

Use only supplied information. You have no web research capability here: never claim to have researched, contacted anyone, verified prices, or performed the work. Turn missing information into an explicit research or clarification step.`;

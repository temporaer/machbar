import type { ReflectionBriefing } from "@machbar/shared";

/** Keep the external coaching instruction visibly separate from Machbar's factual report. */
export function buildReflectionExportText(
  briefing: ReflectionBriefing,
  coachingInstruction: string,
  labels: { coaching: string; briefing: string },
): string {
  return [
    `## ${labels.coaching}`,
    coachingInstruction.trim(),
    "---",
    `## ${labels.briefing}`,
    briefing.markdown.trim(),
  ].join("\n\n");
}

export function downloadReflectionExport(
  content: string,
  format: "markdown" | "text",
): void {
  const isMarkdown = format === "markdown";
  const blob = new Blob([content], {
    type: isMarkdown ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `machbar-reflexion.${isMarkdown ? "md" : "txt"}`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the object URL alive long enough for mobile browsers to start the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

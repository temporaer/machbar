import type { Task } from "@machbar/shared";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { parseReferenceContent } from "../lib/referenceContent";
import { useStrings } from "../lib/strings";
import { MarkdownNotes } from "./MarkdownNotes";
import { PaperlessAttachmentStrip } from "./PaperlessAttachmentStrip";

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function MaterialCard({
  task,
  context,
  paperlessUiBaseUrl,
  keyboardNavigable = false,
}: {
  task: Task;
  context?: string | undefined;
  paperlessUiBaseUrl?: string | null;
  keyboardNavigable?: boolean;
}) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();
  const content = parseReferenceContent(task.notes);

  return (
    <article
      className="material-card"
      data-workitem-id={keyboardNavigable ? task.id : undefined}
      data-workitem-role={keyboardNavigable ? "task" : undefined}
    >
      <div className="material-card-heading">
        <span className="material-card-icon" aria-hidden="true">🗎</span>
        <button
          type="button"
          className={`material-card-open${keyboardNavigable ? " task-row-main" : ""}`}
          aria-label={`${strings.openMaterial}: ${task.title}`}
          onClick={() => dispatch({ type: "task.open", taskId: task.id })}
        >
          {task.title}
        </button>
      </div>
      {context ? <p className="material-card-context">{context}</p> : null}
      {content.primaryWebLink ? (
        <a
          className="material-card-source"
          href={content.primaryWebLink.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${strings.openLink}: ${sourceDomain(content.primaryWebLink.url)}`}
        >
          {sourceDomain(content.primaryWebLink.url)} ↗
        </a>
      ) : null}
      {content.remainingText ? (
        <MarkdownNotes
          value={content.remainingText}
          className="material-card-notes"
        />
      ) : null}
      {content.paperlessAttachments.length > 0 ? (
        <PaperlessAttachmentStrip
          attachments={content.paperlessAttachments}
          paperlessUiBaseUrl={paperlessUiBaseUrl}
        />
      ) : null}
    </article>
  );
}

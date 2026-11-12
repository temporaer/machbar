import { useId, useLayoutEffect, useRef, useState } from "react";
import { MarkdownNotes } from "./MarkdownNotes";
import { useStrings } from "../lib/strings";
import "./DetailNotesPreview.css";

/** Measured Markdown preview; expansion uses the document's scroll surface. */
export function DetailNotesPreview({ value }: { value: string }) {
  const strings = useStrings();
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      const fontSize = parseFloat(getComputedStyle(node).fontSize) || 16;
      setOverflows(node.scrollHeight > fontSize * 7.5 + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [value]);
  useLayoutEffect(() => {
    // Clipped links must not create invisible keyboard stops. Expand to use them.
    if (content.current) content.current.inert = overflows && !expanded;
  }, [overflows, expanded]);
  return <div className="detail-notes-reader">
    <div id={id} className={`detail-notes-preview${overflows && !expanded ? " is-clipped" : ""}`}>
      <div ref={content}><MarkdownNotes value={value} /></div>
    </div>
    {overflows ? <button type="button" className="btn btn-sm detail-notes-expand"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>
      {expanded ? strings.notesShowLess : strings.notesShowMore}
    </button> : null}
  </div>;
}

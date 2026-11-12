import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
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
  const clipped = overflows && !expanded;
  useLayoutEffect(() => {
    if (!clipped || !content.current) return;
    // Preserve readable Markdown in the accessibility tree. Only links lose
    // keyboard/activation access until expansion, including image links.
    const links = Array.from(content.current.querySelectorAll<HTMLAnchorElement>("a[href]"), link => ({
      link, tabIndex: link.getAttribute("tabindex"), disabled: link.getAttribute("aria-disabled"),
    }));
    for (const { link } of links) {
      link.setAttribute("tabindex", "-1");
      link.setAttribute("aria-disabled", "true");
    }
    return () => {
      for (const { link, tabIndex, disabled } of links) {
        if (tabIndex === null) link.removeAttribute("tabindex");
        else link.setAttribute("tabindex", tabIndex);
        if (disabled === null) link.removeAttribute("aria-disabled");
        else link.setAttribute("aria-disabled", disabled);
      }
    };
  }, [clipped, value]);
  const blockClippedLink = (event: MouseEvent<HTMLDivElement>) => {
    if (clipped && event.target instanceof Element && event.target.closest("a[href]")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return <div className="detail-notes-reader">
    <div id={id} className={`detail-notes-preview${clipped ? " is-clipped" : ""}`}>
      <div ref={content} onClickCapture={blockClippedLink} onAuxClickCapture={blockClippedLink}
        onContextMenuCapture={blockClippedLink}><MarkdownNotes value={value} /></div>
    </div>
    {overflows ? <button type="button" className="btn btn-sm detail-notes-expand"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>
      {expanded ? strings.notesShowLess : strings.notesShowMore}
    </button> : null}
  </div>;
}

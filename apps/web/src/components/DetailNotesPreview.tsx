import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { MarkdownNotes } from "./MarkdownNotes";
import { useStrings } from "../lib/strings";
import "./DetailNotesPreview.css";

/** Measured Markdown preview; expansion uses the document's scroll surface. */
export function DetailNotesPreview({ value, onChecklistToggle, checklistDisabled = false }: {
  value: string;
  onChecklistToggle?: (value: string) => void;
  checklistDisabled?: boolean;
}) {
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
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      const preview = node.parentElement;
      if (!preview) return;
      const bottom = preview.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(node).fontSize) || 16) * 2.25;
      for (const checkbox of node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        const label = checkbox.closest("label");
        const item = checkbox.closest("li");
        let obscured = (label ?? checkbox).getBoundingClientRect().bottom > bottom;
        if (clipped && item) {
          for (const child of item.childNodes) {
            if (child === label || (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL"))) continue;
            const range = document.createRange();
            range.selectNode(child);
            if (typeof range.getBoundingClientRect === "function" && range.getBoundingClientRect().bottom > bottom) obscured = true;
          }
        }
        checkbox.disabled = !checkbox.hasAttribute("data-checklist-toggle") || (clipped && obscured);
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [clipped, value, checklistDisabled, onChecklistToggle]);
  const blockClippedLink = (event: MouseEvent<HTMLDivElement>) => {
    if (clipped && event.target instanceof Element && event.target.closest("a[href]")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return <div className="detail-notes-reader">
    <div id={id} className={`detail-notes-preview${clipped ? " is-clipped" : ""}`}>
      <div ref={content} onClickCapture={blockClippedLink} onAuxClickCapture={blockClippedLink}
        onContextMenuCapture={blockClippedLink}><MarkdownNotes value={value} onChecklistToggle={onChecklistToggle}
          checklistDisabled={checklistDisabled} /></div>
    </div>
    {overflows ? <button type="button" className="btn btn-sm detail-notes-expand"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>
      {expanded ? strings.notesShowLess : strings.notesShowMore}
    </button> : null}
  </div>;
}

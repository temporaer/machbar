import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { notePreview, sliceNoteTokens } from "../lib/noteEntries";
import { transformMarkdownUrl } from "./MarkdownNotes";
import { useStrings } from "../lib/strings";
import { NoteEntryTime } from "./NoteEntryTime";

/** Responsive suffix of parsed text, retaining safe links and the actual paragraph ending. */
export function NotesTail({
  value,
  onOpen,
}: {
  value: string;
  onOpen: () => void;
}) {
  const strings = useStrings();
  const preview = useMemo(() => notePreview(value), [value]);
  const ref = useRef<HTMLDivElement>(null);
  const [budget, setBudget] = useState(180);
  const text = preview.tokens.map((t) => t.text).join("");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (!width) return;
      const style = getComputedStyle(el);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.font = `${style.fontSize} ${style.fontFamily}`;
      let lo = 0,
        hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(text.slice(-mid)).width <= width * 2.1) lo = mid;
        else hi = mid - 1;
      }
      setBudget(Math.max(1, lo));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  if (!text.trim()) return null;
  const start = Math.max(0, text.length - budget);
  const tokens = sliceNoteTokens(preview.tokens, start);
  return (
    <div className="notes-tail" ref={ref}>
      <div
        className="notes-tail-text"
        onClick={(event) => {
          if (!(event.target as Element).closest("a,button")) onOpen();
        }}
      >
        {start ? "… " : ""}
        {tokens.map((token, index) => {
          const href = token.href && transformMarkdownUrl(token.href);
          return href ? (
            <a
              key={index}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {token.text}
            </a>
          ) : (
            <span key={index}>{token.text}</span>
          );
        })}
      </div>
      <div className="notes-tail-footer">
        {preview.entry?.instant ? (
          <NoteEntryTime
            instant={preview.entry.instant}
            author={preview.entry.author}
          />
        ) : null}
        <button type="button" onClick={onOpen} aria-label={strings.openNotes}>
          {strings.notes} ↗
        </button>
      </div>
    </div>
  );
}

import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
} from "react";
import "./MarkdownNotes.css";
import { useStrings } from "../lib/strings";
import { MarkdownAttachmentSheet } from "./MarkdownAttachmentSheet";

export type MarkdownToolbarAction = "bullet" | "checkbox" | "bold" | "link";

export interface MarkdownTextTransform {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function insertMarkdownAtSelection(
  value: string,
  start: number,
  end: number,
  markdown: string,
): MarkdownTextTransform {
  const selectionStart = clampSelection(value, Math.min(start, end));
  const selectionEnd = clampSelection(value, Math.max(start, end));
  const nextPosition = selectionStart + markdown.length;
  return {
    value: `${value.slice(0, selectionStart)}${markdown}${value.slice(selectionEnd)}`,
    selectionStart: nextPosition,
    selectionEnd: nextPosition,
  };
}

function clampSelection(value: string, position: number): number {
  return Math.max(0, Math.min(position, value.length));
}

function prefixSelectedLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
): MarkdownTextTransform {
  const lineStart =
    selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineStarts = [lineStart];
  let nextLineStart = value.indexOf("\n", lineStart) + 1;

  while (nextLineStart > 0 && nextLineStart < selectionEnd) {
    lineStarts.push(nextLineStart);
    nextLineStart = value.indexOf("\n", nextLineStart) + 1;
  }

  let transformed = "";
  let cursor = lineStart;
  for (const start of lineStarts) {
    transformed += value.slice(cursor, start);
    transformed += prefix;
    cursor = start;
  }
  transformed += value.slice(cursor, selectionEnd);

  const prefixLength = prefix.length;
  const startsBeforeOrAtSelectionStart = lineStarts.filter((start) => start <= selectionStart).length;
  const startsBeforeSelectionEnd = lineStarts.filter((start) => start < selectionEnd).length;

  return {
    value: `${value.slice(0, lineStart)}${transformed}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + startsBeforeOrAtSelectionStart * prefixLength,
    selectionEnd:
      selectionEnd +
      (selectionStart === selectionEnd
        ? startsBeforeOrAtSelectionStart
        : startsBeforeSelectionEnd) *
        prefixLength,
  };
}

/**
 * Applies a toolbar edit while retaining the meaningful selection position.
 * Kept pure so every editor surface has exactly the same Markdown syntax.
 */
export function applyMarkdownToolbarAction(
  action: MarkdownToolbarAction,
  value: string,
  start: number,
  end: number,
): MarkdownTextTransform {
  const selectionStart = clampSelection(value, Math.min(start, end));
  const selectionEnd = clampSelection(value, Math.max(start, end));

  if (action === "bullet") {
    return prefixSelectedLines(value, selectionStart, selectionEnd, "- ");
  }
  if (action === "checkbox") {
    return prefixSelectedLines(value, selectionStart, selectionEnd, "- [ ] ");
  }

  const selected = value.slice(selectionStart, selectionEnd);
  if (action === "bold") {
    return {
      value: `${value.slice(0, selectionStart)}**${selected}**${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + 2,
      selectionEnd: selectionEnd + 2,
    };
  }

  const before = value.slice(0, selectionStart);
  const link = `[${selected}]()`;
  const caret = before.length + selected.length + 3;
  return {
    value: `${before}${link}${value.slice(selectionEnd)}`,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export interface MarkdownEditorProps
  extends Omit<ComponentPropsWithoutRef<"textarea">, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  toolbarLabel?: string;
}

export const MarkdownEditor = forwardRef<HTMLTextAreaElement, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      toolbarLabel,
      className,
      disabled,
      ...textareaProps
    },
    forwardedRef,
  ) {
    const strings = useStrings();
    const resolvedToolbarLabel = toolbarLabel ?? strings.markdownToolbar;
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const attachmentSelectionRef = useRef({ start: 0, end: 0 });
    const [attachmentOpen, setAttachmentOpen] = useState(false);
    const setTextareaRef = useCallback(
      (element: HTMLTextAreaElement | null) => {
        textareaRef.current = element;
        assignRef(forwardedRef, element);
      },
      [forwardedRef],
    );

    const restoreSelection = (transform: MarkdownTextTransform) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const apply = () => {
        textarea.focus();
        textarea.setSelectionRange(transform.selectionStart, transform.selectionEnd);
      };
      apply();
      queueMicrotask(apply);
    };

    const applyAction = (action: MarkdownToolbarAction) => {
      const textarea = textareaRef.current;
      if (!textarea || disabled) return;
      const transform = applyMarkdownToolbarAction(
        action,
        value,
        textarea.selectionStart,
        textarea.selectionEnd,
      );
      onChange(transform.value);
      restoreSelection(transform);
    };

    const openAttachments = () => {
      const textarea = textareaRef.current;
      if (!textarea || disabled) return;
      attachmentSelectionRef.current = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
      setAttachmentOpen(true);
    };

    const insertAttachment = (markdown: string) => {
      const selection = attachmentSelectionRef.current;
      const currentValue = textareaRef.current?.value ?? value;
      const transform = insertMarkdownAtSelection(
        currentValue,
        selection.start,
        selection.end,
        markdown,
      );
      onChange(transform.value);
      setAttachmentOpen(false);
      restoreSelection(transform);
    };

    const onTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
    };

    return (
      <div className="markdown-editor">
        <div
          className="markdown-editor-toolbar"
          role="toolbar"
          aria-label={resolvedToolbarLabel}
        >
          <button
            type="button"
            className="markdown-editor-action"
            aria-label={strings.markdownBulletList}
            title={strings.markdownBulletList}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyAction("bullet")}
          >
            <span aria-hidden="true">•</span>
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            aria-label={strings.markdownTaskList}
            title={strings.markdownTaskList}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyAction("checkbox")}
          >
            <span aria-hidden="true">☑</span>
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            aria-label={strings.markdownBold}
            title={strings.markdownBold}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyAction("bold")}
          >
            <strong aria-hidden="true">B</strong>
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            aria-label={strings.markdownLink}
            title={strings.markdownLink}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyAction("link")}
          >
            <span aria-hidden="true">↗</span>
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            aria-label={strings.markdownAttachment}
            title={strings.markdownAttachment}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openAttachments}
          >
            <span aria-hidden="true">📎</span>
          </button>
        </div>
        <textarea
          {...textareaProps}
          ref={setTextareaRef}
          className={["markdown-editor-textarea", className].filter(Boolean).join(" ")}
          disabled={disabled}
          value={value}
          onChange={onTextareaChange}
        />
        {attachmentOpen ? (
          <MarkdownAttachmentSheet
            onInsert={insertAttachment}
            onClose={() => setAttachmentOpen(false)}
          />
        ) : null}
      </div>
    );
  },
);

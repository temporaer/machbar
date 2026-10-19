import {
  forwardRef,
  useCallback,
  useEffect,
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
  const first =
    selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1;
  const last = value.indexOf("\n", selectionEnd > selectionStart ? selectionEnd - 1 : selectionEnd);
  const stop = last < 0 ? value.length : last;
  const source = value.slice(first, stop);
  const lines = source.split("\n");
  const pattern = /^(\s*)(?:[-*+] |\d+[.)] )(?:\[[ xX]\] )?/;
  const desired = prefix === "- [ ] " ? "checkbox" : "bullet";
  const same = lines.every((line) =>
    desired === "checkbox"
      ? /^\s*[-*+] \[[ xX]\] /.test(line)
      : /^\s*[-*+] (?!\[[ xX]\] )/.test(line),
  );
  const edits = lines.map((line) => {
    const match = line.match(pattern);
    const indent = match?.[1] ?? line.match(/^\s*/)?.[0] ?? "";
    const old = match?.[0].length ?? indent.length;
    const replacement = indent + (same ? "" : prefix);
    return { old, replacement, text: replacement + line.slice(old) };
  });
  const mapPosition = (position: number) => {
    let offset = first,
      delta = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!,
        edit = edits[index]!;
      if (position <= offset + line.length)
        return (
          position +
          delta +
          edit.replacement.length -
          Math.min(edit.old, Math.max(0, position - offset))
        );
      delta += edit.replacement.length - edit.old;
      offset += line.length + 1;
    }
    return position + delta;
  };
  return {
    value:
      value.slice(0, first) +
      edits.map((e) => e.text).join("\n") +
      value.slice(stop),
    selectionStart: mapPosition(selectionStart),
    selectionEnd: mapPosition(selectionEnd),
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

/** Continue only the current list item, preserving the suffix and selected-text semantics. */
export function continueMarkdownList(
  value: string,
  start: number,
  end: number,
): MarkdownTextTransform | null {
  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const before = value.slice(lineStart, start);
  const match = before.match(/^(\s*)([-*+]|\d+[.)]) (?:\[([ xX])\] )?/);
  if (!match) return null;
  const lineEnd = value.indexOf("\n", end);
  const suffix = value.slice(end, lineEnd < 0 ? value.length : lineEnd);
  if (!before.slice(match[0].length).trim() && !suffix.trim()) {
    // An empty nested item exits one level; the following Enter can exit the outer list.
    const indent = match[1]!;
    const replacement = indent.length
      ? indent.slice(0, Math.max(0, indent.length - 2)) +
        match[2] +
        " " +
        (match[3] !== undefined ? "[ ] " : "")
      : "";
    return {
      value: value.slice(0, lineStart) + replacement + value.slice(end),
      selectionStart: lineStart + replacement.length,
      selectionEnd: lineStart + replacement.length,
    };
  }
  const marker = /^\d/.test(match[2]!)
    ? `${Number.parseInt(match[2]!, 10) + 1}${match[2]!.slice(-1)}`
    : match[2]!;
  const insertion = `\n${match[1]}${marker} ${match[3] !== undefined ? "[ ] " : ""}`;
  return insertMarkdownAtSelection(value, start, end, insertion);
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

export const MarkdownEditor = forwardRef<
  HTMLTextAreaElement,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    value,
    onChange,
    toolbarLabel,
    className,
    disabled,
    readOnly,
    onKeyDown,
    onBeforeInput,
    ...textareaProps
  },
  forwardedRef,
) {
  const strings = useStrings();
  const resolvedToolbarLabel = toolbarLabel ?? strings.markdownToolbar;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plainEnterRef = useRef(false);
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
      textarea.setSelectionRange(
        transform.selectionStart,
        transform.selectionEnd,
      );
    };
    apply();
    queueMicrotask(apply);
  };

  const applyTransform = (transform: MarkdownTextTransform) => {
    const textarea = textareaRef.current;
    if (!textarea || disabled || readOnly) return;
    // A native insertText edit participates in the browser undo stack. Replace
    // only the changed range, rather than assigning the controlled value first.
    let first = 0;
    while (
      first < textarea.value.length &&
      first < transform.value.length &&
      textarea.value[first] === transform.value[first]
    )
      first++;
    let oldEnd = textarea.value.length,
      newEnd = transform.value.length;
    while (
      oldEnd > first &&
      newEnd > first &&
      textarea.value[oldEnd - 1] === transform.value[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    textarea.focus();
    textarea.setSelectionRange(first, oldEnd);
    const nativeEdit = document.execCommand?.(
      "insertText",
      false,
      transform.value.slice(first, newEnd),
    );
    if (!nativeEdit) onChange(transform.value);
    restoreSelection(transform);
  };
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const beforeInput = (event: InputEvent) => {
      if (plainEnterRef.current) {
        plainEnterRef.current = false;
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        disabled ||
        readOnly ||
        !["insertLineBreak", "insertParagraph"].includes(event.inputType)
      )
        return;
      const transform = continueMarkdownList(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
      );
      if (transform && event.cancelable) {
        event.preventDefault();
        applyTransform(transform);
      }
    };
    textarea.addEventListener("beforeinput", beforeInput);
    return () => textarea.removeEventListener("beforeinput", beforeInput);
  });

  const applyAction = (action: MarkdownToolbarAction) => {
    const textarea = textareaRef.current;
    if (!textarea || disabled || readOnly) return;
    const transform = applyMarkdownToolbarAction(
      action,
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
    );
    applyTransform(transform);
  };

  const openAttachments = () => {
    const textarea = textareaRef.current;
    if (!textarea || disabled || readOnly) return;
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
          disabled={disabled || readOnly}
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
          disabled={disabled || readOnly}
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
          disabled={disabled || readOnly}
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
          disabled={disabled || readOnly}
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
          disabled={disabled || readOnly}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openAttachments}
        >
          <span aria-hidden="true">📎</span>
        </button>
      </div>
      <textarea
        {...textareaProps}
        ref={setTextareaRef}
        className={["markdown-editor-textarea", className]
          .filter(Boolean)
          .join(" ")}
        disabled={disabled || readOnly}
        readOnly={readOnly}
        onBeforeInput={onBeforeInput}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          plainEnterRef.current = event.key === "Enter" && event.shiftKey;
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            disabled ||
            readOnly ||
            event.key !== "Enter" ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          )
            return;
          const textarea = event.currentTarget;
          const transform = continueMarkdownList(
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd,
          );
          if (transform) {
            event.preventDefault();
            applyTransform(transform);
          }
        }}
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
});

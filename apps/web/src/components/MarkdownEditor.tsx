import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  runScopeHandlers,
  placeholder as editorPlaceholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  insertNewlineAndIndent,
  isolateHistory,
} from "@codemirror/commands";
import {
  markdown,
  commonmarkLanguage,
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
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
  const last = value.indexOf(
    "\n",
    selectionEnd > selectionStart ? selectionEnd - 1 : selectionEnd,
  );
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

/** The shared editor's focus/selection boundary; callers never depend on CodeMirror. */
export interface MarkdownEditorHandle {
  focus(): void;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  insertMarkdown(markdown: string): void;
}
export interface MarkdownEditorProps
  extends Omit<
    ComponentPropsWithoutRef<"div">,
    "onChange" | "onKeyDown" | "onBeforeInput"
  > {
  value: string;
  onChange: (value: string) => void;
  toolbarLabel?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onKeyDown?: ComponentPropsWithoutRef<"div">["onKeyDown"];
}
const externalValue = Annotation.define<boolean>();
const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    value,
    onChange,
    toolbarLabel,
    rows = 5,
    disabled = false,
    readOnly = false,
    autoFocus = false,
    placeholder = "",
    className,
    id,
    onKeyDown,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    ...props
  },
  ref,
) {
  const strings = useStrings();
  const resolvedToolbarLabel = toolbarLabel ?? strings.markdownToolbar;
  const host = useRef<HTMLDivElement>(null),
    viewRef = useRef<EditorView | null>(null);
  const options = useRef(new Compartment());
  const historyOptions = useRef(new Compartment());
  const latest = useRef({ onChange, disabled, readOnly });
  latest.current = { onChange, disabled, readOnly };
  const attachmentSelectionRef = useRef({ start: 0, end: 0 });
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      scrollIntoView: (opts) => host.current?.scrollIntoView(opts),
      get value() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      get selectionStart() {
        return viewRef.current?.state.selection.main.from ?? 0;
      },
      get selectionEnd() {
        return viewRef.current?.state.selection.main.to ?? 0;
      },
      insertMarkdown: (markdown) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        applyTransform(
          insertMarkdownAtSelection(
            view.state.doc.toString(),
            from,
            to,
            markdown,
          ),
        );
      },
      setSelectionRange: (start, end) => {
        const view = viewRef.current;
        if (view)
          view.dispatch({
            selection: {
              anchor: clampSelection(view.state.doc.toString(), start),
              head: clampSelection(view.state.doc.toString(), end),
            },
          });
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          historyOptions.current.of(history()),
          markdown({
            base: commonmarkLanguage,
            extensions: GFM,
            addKeymap: false,
            completeHTMLTags: false,
          }),
          keymap.of([
            {
              key: "Enter",
              run: (view) =>
                continueMarkup(view) || insertNewlineAndIndent(view),
            },
            { key: "Shift-Enter", run: insertNewline },
            { key: "Backspace", run: deleteMarkupBackward },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          options.current.of([]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalValue))
            )
              latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const attrs: Record<string, string> = {
      "aria-multiline": "true",
      "aria-disabled": String(disabled),
      "aria-readonly": String(readOnly),
    };
    if (id) attrs.id = id;
    if (ariaLabel) attrs["aria-label"] = ariaLabel;
    if (ariaLabelledBy) attrs["aria-labelledby"] = ariaLabelledBy;
    const effects = options.current.reconfigure([
      EditorState.readOnly.of(disabled || readOnly),
      EditorView.editable.of(!disabled && !readOnly),
      EditorView.contentAttributes.of(attrs),
      editorPlaceholder(placeholder),
      EditorView.theme({
        "&": {
          background: "var(--color-surface)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
        },
        "&.cm-focused": {
          outline:
            "3px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
        },
        ".cm-content": {
          fontFamily: "inherit",
          padding: "9px 10px",
          minHeight: `${Math.max(2, rows) * 1.5}em`,
        },
        ".cm-line": { padding: "0" },
        ".cm-scroller": {
          fontFamily: "inherit",
          lineHeight: "1.5",
          overflow: "auto",
        },
      }),
    ]);
    view.dispatch({ effects });
  }, [disabled, readOnly, id, ariaLabel, ariaLabelledBy, placeholder, rows]);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      // A caller replacement (cancel, entity switch, server refresh) establishes
      // a new baseline. Do not map edits/redo from another document through it.
      view.dispatch({ effects: historyOptions.current.reconfigure([]) });
      const { anchor, head } = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: {
          anchor: Math.min(anchor, value.length),
          head: Math.min(head, value.length),
        },
        annotations: [
          externalValue.of(true),
          Transaction.addToHistory.of(false),
          isolateHistory.of("full"),
        ],
        effects: historyOptions.current.reconfigure(history()),
      });
    }
  }, [value]);

  const applyTransform = (transform: MarkdownTextTransform) => {
    const view = viewRef.current;
    if (!view || latest.current.disabled || latest.current.readOnly) return;
    const current = view.state.doc.toString();
    let first = 0,
      oldEnd = current.length,
      newEnd = transform.value.length;
    while (
      first < oldEnd &&
      first < newEnd &&
      current[first] === transform.value[first]
    )
      first++;
    while (
      oldEnd > first &&
      newEnd > first &&
      current[oldEnd - 1] === transform.value[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    view.dispatch({
      changes: {
        from: first,
        to: oldEnd,
        insert: transform.value.slice(first, newEnd),
      },
      selection: {
        anchor: transform.selectionStart,
        head: transform.selectionEnd,
      },
      annotations: [
        Transaction.userEvent.of("input"),
        isolateHistory.of("full"),
      ],
      scrollIntoView: true,
    });
    view.focus();
  };
  const applyAction = (action: MarkdownToolbarAction) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    applyTransform(
      applyMarkdownToolbarAction(action, view.state.doc.toString(), from, to),
    );
  };
  const openAttachments = () => {
    const view = viewRef.current;
    if (!view || disabled || readOnly) return;
    const { from, to } = view.state.selection.main;
    attachmentSelectionRef.current = { start: from, end: to };
    setAttachmentOpen(true);
  };
  const insertAttachment = (markdown: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { start, end } = attachmentSelectionRef.current;
    applyTransform(
      insertMarkdownAtSelection(
        view.state.doc.toString(),
        start,
        end,
        markdown,
      ),
    );
    setAttachmentOpen(false);
  };
  return (
    <div
      {...props}
      className={["markdown-editor", className].filter(Boolean).join(" ")}
      onKeyDownCapture={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
          event.stopPropagation();
          return;
        }
        const view = viewRef.current;
        // Chrome Android defers Enter and drops its Shift modifier. Run the
        // configured CodeMirror keymap before that deferral for hardware Shift+Enter.
        if (
          view &&
          !disabled &&
          !readOnly &&
          event.key === "Enter" &&
          event.shiftKey &&
          !event.nativeEvent.isComposing &&
          view.contentDOM.contains(event.target as Node) &&
          runScopeHandlers(view, event.nativeEvent, "editor")
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
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
      <div className="markdown-editor-surface" ref={host} />
      {attachmentOpen ? (
        <MarkdownAttachmentSheet
          onInsert={insertAttachment}
          onClose={() => setAttachmentOpen(false)}
        />
      ) : null}
    </div>
  );
});

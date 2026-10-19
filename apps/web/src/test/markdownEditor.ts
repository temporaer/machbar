import { act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";

/** Drive the editor model in jsdom; browser tests cover native typing and IME. */
export function markdownView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("Expected a mounted MarkdownEditor");
  return view;
}
export function markdownValue(element: HTMLElement): string {
  return markdownView(element).state.doc.toString();
}
export function selectMarkdown(
  element: HTMLElement,
  start: number,
  end = start,
) {
  act(() =>
    markdownView(element).dispatch({ selection: { anchor: start, head: end } }),
  );
}
export function setMarkdownValue(element: HTMLElement, value: string) {
  const view = markdownView(element);
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: value.length },
      annotations: Transaction.userEvent.of("input"),
    }),
  );
}

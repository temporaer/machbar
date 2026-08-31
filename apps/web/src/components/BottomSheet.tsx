import { useId, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../lib/strings";
import { IconActionButton } from "./IconActionButton";

type SheetEntry = {
  id: symbol;
  order: number;
  dialog: HTMLDivElement;
  backdrop: HTMLDivElement;
  opener: HTMLElement | null;
  close: () => void;
};

type HiddenState = {
  ariaHidden: string | null;
  inert: string | null;
};

const sheetStack: SheetEntry[] = [];
const hiddenElements = new Map<HTMLElement, HiddenState>();
let nextSheetOrder = 0;
let bodyOverflow: string | null = null;

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button",
  "summary",
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  "[tabindex]",
].join(",");

function isHiddenByClosedDetails(element: HTMLElement) {
  const details = element.closest("details:not([open])");
  return details !== null && details.firstElementChild !== element;
}

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
      !isHiddenByClosedDetails(element),
  );
}

function topSheet() {
  return sheetStack.at(-1);
}

function restoreHiddenState(element: HTMLElement, state: HiddenState) {
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);

  if (state.inert === null) element.removeAttribute("inert");
  else element.setAttribute("inert", state.inert);
}

function setHiddenElements(elements: Set<HTMLElement>) {
  for (const [element, state] of hiddenElements) {
    if (!elements.has(element)) {
      restoreHiddenState(element, state);
      hiddenElements.delete(element);
    }
  }

  for (const element of elements) {
    if (!hiddenElements.has(element)) {
      hiddenElements.set(element, {
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.getAttribute("inert"),
      });
    }
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
  }
}

function updatePageIsolation() {
  const elements = new Set<HTMLElement>();
  const root = document.getElementById("root");
  if (root && sheetStack.length > 0) elements.add(root);

  for (const entry of sheetStack.slice(0, -1)) {
    elements.add(entry.backdrop);
    elements.add(entry.dialog);
  }
  setHiddenElements(elements);
}

function focusSheet(entry: SheetEntry) {
  if (entry.dialog.contains(document.activeElement)) return;
  const focusable = focusableElements(entry.dialog);
  const firstContentControl = focusable.find(
    (element) => !element.closest(".sheet-header"),
  );
  (firstContentControl ?? focusable[0] ?? entry.dialog).focus();
}

function onDocumentKeyDown(event: KeyboardEvent) {
  const entry = topSheet();
  if (!entry) return;

  if (event.key === "Escape") {
    event.preventDefault();
    entry.close();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = focusableElements(entry.dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    entry.dialog.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (!entry.dialog.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function registerSheet(entry: SheetEntry) {
  if (sheetStack.length === 0) {
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onDocumentKeyDown);
  }

  sheetStack.push(entry);
  sheetStack.sort((left, right) => left.order - right.order);
  updatePageIsolation();
  if (topSheet() === entry) focusSheet(entry);
}

function unregisterSheet(id: symbol) {
  const index = sheetStack.findIndex((entry) => entry.id === id);
  if (index < 0) return;

  const wasTop = index === sheetStack.length - 1;
  const entry = sheetStack[index]!;
  for (const nestedEntry of sheetStack.slice(index + 1)) {
    if (nestedEntry.opener && entry.dialog.contains(nestedEntry.opener)) {
      nestedEntry.opener = entry.opener;
    }
  }
  sheetStack.splice(index, 1);
  updatePageIsolation();

  if (sheetStack.length === 0) {
    document.removeEventListener("keydown", onDocumentKeyDown);
    document.body.style.overflow = bodyOverflow ?? "";
    bodyOverflow = null;
  }

  if (wasTop && entry.opener?.isConnected) {
    const opener = entry.opener;
    const nextTopId = topSheet()?.id;
    opener.focus();
    queueMicrotask(() => {
      if (opener.isConnected && topSheet()?.id === nextTopId) opener.focus();
    });
  }
}

export function BottomSheet({
  title,
  onClose,
  children,
  labelledBy,
  headerActions,
  headerStatus,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  headerActions?: ReactNode;
  headerStatus?: ReactNode;
}) {
  const strings = useStrings();
  const internalHeadingId = useId();
  const headingId = labelledBy ?? internalHeadingId;
  const idRef = useRef(Symbol("bottom-sheet"));
  const orderRef = useRef<number | null>(null);
  const order = orderRef.current ?? (orderRef.current = nextSheetOrder++);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    if (!dialog || !backdrop) return;

    registerSheet({
      id: idRef.current,
      order,
      dialog,
      backdrop,
      opener: openerRef.current,
      close: () => onCloseRef.current(),
    });
    return () => unregisterSheet(idRef.current);
  }, []);

  return createPortal(
    <div
      ref={backdropRef}
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && topSheet()?.id === idRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        tabIndex={-1}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        {title ? (
          <>
            <div className="sheet-header">
              <h2 id={headingId}>{title}</h2>
              <div className="sheet-header-actions">
                {headerActions}
                <IconActionButton kind="close" label={strings.close} onClick={onClose} />
              </div>
            </div>
            {headerStatus ? <div className="sheet-header-status">{headerStatus}</div> : null}
          </>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useState } from "react";
import type { FocusEvent } from "react";

/** Menus, keyboard focus and gestures protect the row; pointer focus alone
 * must not pin a clicked checkbox indefinitely. */
export function useRetentionInteraction(id: number | null, pause: (id: number) => () => void, open = false) {
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [pointerDown, setPointerDown] = useState(false);
  useEffect(() => {
    if (id !== null && (open || keyboardFocus || pointerDown)) return pause(id);
  }, [id, pause, open, keyboardFocus, pointerDown]);
  useEffect(() => {
    if (!pointerDown) return;
    const end = () => setPointerDown(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [pointerDown]);
  return {
    onFocusCapture: (event: FocusEvent<HTMLElement>) => setKeyboardFocus(event.target.matches(":focus-visible")),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocus(false);
    },
    onPointerDownCapture: () => { setKeyboardFocus(false); setPointerDown(true); },
    onPointerUpCapture: () => setPointerDown(false),
    onPointerCancelCapture: () => setPointerDown(false),
  };
}

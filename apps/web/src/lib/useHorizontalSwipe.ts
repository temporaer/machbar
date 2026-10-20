import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MouseEventHandler,
  PointerEventHandler,
} from "react";

const DRAG_SLOP = 8;
const MAX_DRAG_X = 160;
const ACTION_THRESHOLD = 64;
/**
 * Exported so callers with a two-tier primary swipe (see `onDeepPrimary`
 * below) can show live visual feedback — e.g. a background/label change —
 * once a drag in progress has crossed into "deep" territory, without
 * waiting for pointer-up.
 */
export const DEEP_ACTION_THRESHOLD = 128;

export interface HorizontalSwipeOptions {
  disabled?: boolean;
  ignoreInteractive?: boolean;
  onPrimary: () => void;
  onSecondary: () => void;
  onDeepPrimary?: () => void;
  onRealDrag?: () => void;
}

export interface HorizontalSwipeHandlers<T extends HTMLElement> {
  onPointerDown: PointerEventHandler<T>;
  onPointerMove: PointerEventHandler<T>;
  onPointerUp: PointerEventHandler<T>;
  onPointerCancel: PointerEventHandler<T>;
  onClickCapture: MouseEventHandler<T>;
}

/**
 * Headless horizontal gesture state shared by swipeable rows and cards.
 *
 * Row-specific actions, presentation and labels deliberately remain with the
 * caller.
 */
export function useHorizontalSwipe<T extends HTMLElement = HTMLElement>(
  options: HorizontalSwipeOptions,
) {
  const [dragX, setDragX] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gesture = useRef({
    active: false,
    startX: 0,
    startY: 0,
    pointerId: 0,
    realDrag: false,
    captured: false,
    dragX: 0,
  });
  const suppressNextClick = useRef(false);

  const reset = useCallback(() => {
    gesture.current.active = false;
    gesture.current.realDrag = false;
    gesture.current.captured = false;
    gesture.current.dragX = 0;
    setDragX(0);
  }, []);

  const cancel = useCallback(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (options.disabled) reset();
  }, [options.disabled, reset]);

  const onPointerDown = useCallback<PointerEventHandler<T>>((event) => {
    // A fresh pointer sequence is an unrelated interaction, so it must never
    // inherit click suppression from an earlier drag.
    suppressNextClick.current = false;
    if (optionsRef.current.disabled || gesture.current.active || !event.isPrimary || event.button !== 0) return;
    if (optionsRef.current.ignoreInteractive && event.target instanceof Element &&
      event.target.closest("input, textarea, select, button, a, label, summary, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='textbox'], [tabindex]:not([tabindex='-1'])")) return;
    gesture.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      realDrag: false,
      captured: false,
      dragX: 0,
    };
  }, []);

  const onPointerMove = useCallback<PointerEventHandler<T>>((event) => {
    const current = gesture.current;
    if (!current.active || current.pointerId !== event.pointerId) return;
    if (optionsRef.current.disabled) {
      reset();
      return;
    }

    const delta = event.clientX - current.startX;
    if (!current.realDrag) {
      const deltaY = event.clientY - current.startY;
      if (Math.max(Math.abs(delta), Math.abs(deltaY)) <= DRAG_SLOP) return;
      if (Math.abs(deltaY) >= Math.abs(delta)) {
        reset();
        return;
      }
      current.realDrag = true;
      optionsRef.current.onRealDrag?.();
    }
    if (!current.captured && current.realDrag) {
      current.captured = true;
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    current.dragX = Math.max(-MAX_DRAG_X, Math.min(MAX_DRAG_X, delta));
    setDragX(current.dragX);
  }, [reset]);

  const onPointerUp = useCallback<PointerEventHandler<T>>((event) => {
    const current = gesture.current;
    if (!current.active || current.pointerId !== event.pointerId) return;

    const completedDragX = current.dragX;
    suppressNextClick.current = current.realDrag;
    reset();
    if (optionsRef.current.disabled) return;
    if (completedDragX >= ACTION_THRESHOLD) {
      if (completedDragX >= DEEP_ACTION_THRESHOLD && optionsRef.current.onDeepPrimary) {
        optionsRef.current.onDeepPrimary();
      } else {
        optionsRef.current.onPrimary();
      }
    } else if (completedDragX <= -ACTION_THRESHOLD) {
      optionsRef.current.onSecondary();
    }
  }, [reset]);

  const onClickCapture = useCallback<MouseEventHandler<T>>((event) => {
    if (!suppressNextClick.current) return;
    suppressNextClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlers: HorizontalSwipeHandlers<T> = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancel,
    onClickCapture,
  };

  return { dragX, handlers, cancel };
}

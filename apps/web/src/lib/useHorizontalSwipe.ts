import { useCallback, useRef, useState } from "react";
import type {
  MouseEventHandler,
  PointerEventHandler,
} from "react";

const DRAG_SLOP = 8;
const MAX_DRAG_X = 140;
const ACTION_THRESHOLD = 72;

export interface HorizontalSwipeOptions {
  disabled?: boolean;
  onPrimary: () => void;
  onSecondary: () => void;
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
 * Headless horizontal gesture state shared by swipeable rows.
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

  const onPointerDown = useCallback<PointerEventHandler<T>>((event) => {
    // A fresh pointer sequence is an unrelated interaction, so it must never
    // inherit click suppression from an earlier drag.
    suppressNextClick.current = false;
    if (optionsRef.current.disabled) return;
    gesture.current = {
      active: true,
      startX: event.clientX,
      realDrag: false,
      captured: false,
      dragX: 0,
    };
  }, []);

  const onPointerMove = useCallback<PointerEventHandler<T>>((event) => {
    const current = gesture.current;
    if (!current.active) return;

    const delta = event.clientX - current.startX;
    if (!current.realDrag && Math.abs(delta) > DRAG_SLOP) {
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
  }, []);

  const onPointerUp = useCallback<PointerEventHandler<T>>(() => {
    const current = gesture.current;
    if (!current.active) return;

    const completedDragX = current.dragX;
    suppressNextClick.current = current.realDrag;
    reset();
    if (completedDragX > ACTION_THRESHOLD) {
      optionsRef.current.onPrimary();
    } else if (completedDragX < -ACTION_THRESHOLD) {
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

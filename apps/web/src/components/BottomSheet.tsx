import { useEffect } from "react";
import type { ReactNode } from "react";
import { strings } from "../lib/strings";

export function BottomSheet({
  title,
  onClose,
  children,
  labelledBy,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="sheet-grabber" aria-hidden="true" />
        {title ? (
          <div className="sheet-header">
            <h2 id={labelledBy}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={strings.close}>
              ×
            </button>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

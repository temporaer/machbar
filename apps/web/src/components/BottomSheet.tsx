import { useEffect } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../lib/strings";
import { IconActionButton } from "./IconActionButton";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="sheet-grabber" aria-hidden="true" />
        {title ? (
          <>
            <div className="sheet-header">
              <h2 id={labelledBy}>{title}</h2>
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

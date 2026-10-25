import { useEffect, useState, type ReactNode } from "react";
import { BottomSheet } from "./BottomSheet";
import { ActionTileGrid, type ActionTileDescriptor } from "./ActionTileGrid";

/** Shared presentation only: callers supply existing semantic commands. */
export function DetailActionMenu({ label, items, children, disabled, resetKey }: {
  label: string;
  items: readonly ActionTileDescriptor[];
  children?: ReactNode;
  disabled?: boolean;
  resetKey: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [resetKey]);
  if (!items.length && !children) return null;
  return <>
    <button type="button" className="detail-menu-trigger" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{label}</button>
    {open ? <BottomSheet title={label} initialFocus="dialog" onClose={() => setOpen(false)}>
      <div className="detail-action-menu">
        <ActionTileGrid items={items.map((item) => ({ ...item, disabled: Boolean(disabled || item.disabled), onClick: () => {
          setOpen(false);
          item.onClick();
        } }))} />
        {children ? <div className="detail-menu-sharing">{children}</div> : null}
      </div>
    </BottomSheet> : null}
  </>;
}

import type { ReactNode } from "react";

/**
 * Canonical scalar-property pill shared by Task and Project detail
 * surfaces. Renders the existing `.detail-meta-button` geometry/padding/
 * typography/border/hover/hit-target for a *set* property, or the same
 * geometry with a muted "add" treatment (`variant="unset"`) for a property
 * that has no value yet — color is the only structural difference between
 * the two, per the shared interaction grammar. `StatusBadge`/
 * `ProjectStatusBadge` additionally layer semantic status color on top of
 * this same base class; that is the one deliberate exception beyond color.
 */
export function DetailPropertyPill({
  label,
  children,
  onClick,
  ariaLabel,
  variant = "set",
  extraClassName,
  disabled,
}: {
  label?: string;
  children: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  variant?: "set" | "unset";
  extraClassName?: string;
  disabled?: boolean;
}) {
  const classes = ["detail-meta-button"];
  if (variant === "unset") classes.push("detail-meta-add-button");
  if (extraClassName) classes.push(extraClassName);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >
      {label ? <span className="detail-meta-label">{label}</span> : null}
      {children}
    </button>
  );
}

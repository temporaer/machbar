import type { ReactNode } from "react";

/** Current-value control shared by detail summaries and focused planning.
 * Summary groups provide quiet styling; editors keep their existing pill
 * treatment. Both preserve the same click and accessible-name contract. */
export function DetailPropertyPill({
  label,
  children,
  onClick,
  ariaLabel,
  variant = "set",
  extraClassName,
  disabled,
  ariaExpanded,
  ariaControls,
}: {
  label?: string | undefined;
  children: ReactNode;
  onClick: () => void;
  ariaLabel?: string | undefined;
  variant?: "set" | "unset";
  extraClassName?: string;
  disabled?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  const classes = ["detail-meta-button"];
  if (variant === "unset") classes.push("detail-meta-add-button");
  if (extraClassName) classes.push(extraClassName);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      disabled={disabled}
      onClick={onClick}
    >
      {label ? <span className="detail-meta-label">{label}</span> : null}
      {children}
    </button>
  );
}

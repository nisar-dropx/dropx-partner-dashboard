"use client";

import type { ButtonHTMLAttributes } from "react";

type ConnectButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ConnectButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ConnectButtonVariant;
  compact?: boolean;
};

const variantClassName: Record<ConnectButtonVariant, string> = {
  primary: "connect-primary",
  secondary: "connect-secondary",
  ghost: "connect-text-button",
  danger: "connect-secondary danger"
};

/**
 * Canonical Connect button primitive. Wraps the shared `.connect-primary` /
 * `.connect-secondary` / `.connect-text-button` classes defined in
 * `app/globals.css` so new or touched screens converge on one set of
 * button styles instead of inventing another one-off class name.
 *
 * This does not replace the ~130+ existing raw `<button className="...">`
 * call sites across Connect's screens — only newly written or incidentally
 * touched buttons should adopt it, per the UI overhaul's scoped approach.
 */
export function ConnectButton({ variant = "primary", compact = false, className, type = "button", ...rest }: ConnectButtonProps) {
  const classes = [variantClassName[variant], compact ? "compact" : "", className].filter(Boolean).join(" ");
  return <button className={classes} type={type} {...rest} />;
}

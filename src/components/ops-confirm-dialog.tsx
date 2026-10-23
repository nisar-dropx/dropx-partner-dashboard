"use client";

import { useEffect, useId, type ReactNode } from "react";
import styles from "./ops-confirm-dialog.module.css";

type Props = {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSecondary?: () => void;
};

/** Lightweight two-action modal for Ops Pulse destructive / start flows. */
export function OpsConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  secondaryLabel,
  danger,
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
  onSecondary,
}: Props) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        {description ? <div className={styles.copy}>{description}</div> : null}
        {children ? <div className={styles.body}>{children}</div> : null}
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button type="button" disabled={busy} onClick={onSecondary}>
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={danger ? styles.danger : styles.primary}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

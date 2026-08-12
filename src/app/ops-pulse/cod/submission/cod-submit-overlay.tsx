"use client";

import { useFormStatus } from "react-dom";

export function CodSubmitPendingOverlay({
  isAmazon,
  savingLabel = "Saving COD submission…",
  detail
}: {
  isAmazon: boolean;
  savingLabel?: string;
  detail?: string;
}) {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div className="cod-submit-overlay" aria-live="polite" aria-busy="true">
      <div className="cod-submit-overlay-card">
        <span className="page-spinner" aria-hidden="true" />
        <strong>{isAmazon ? "Verifying remittance & saving…" : savingLabel}</strong>
        {detail ? <p className="subtle" style={{ margin: 0 }}>{detail}</p> : null}
      </div>
    </div>
  );
}

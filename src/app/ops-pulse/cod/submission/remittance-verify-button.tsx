"use client";

import { useState, useTransition } from "react";

type VerifyResponse = {
  verified?: boolean;
  codeFound?: boolean;
  amountMatched?: boolean;
  depositDateMatched?: boolean;
  creationPeriodMatched?: boolean;
  submitterMatched?: boolean;
  failureReason?: string | null;
  error?: string;
  nearMisses?: { actualAmount?: number }[];
};

export function RemittanceVerifyButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="span-3" style={{ display: "grid", gap: 8 }}>
      <div className="form-actions" style={{ justifyContent: "flex-start", gap: 10 }}>
        <button
          className="button secondary"
          disabled={pending}
          type="button"
          onClick={(event) => {
            const form = event.currentTarget.closest("form");
            if (!form) return;
            const data = new FormData(form);
            const stationCode = String(data.get("station_code") ?? "").trim().toUpperCase();
            const date = String(data.get("deposit_date") ?? "").trim();
            const remittanceCode = String(data.get("remittance_code") ?? "").trim();
            const amountRaw = String(data.get("deposited_amount") ?? "").trim();
            const codPeriodFrom = String(data.get("cod_period_from") ?? "").trim();
            const codPeriodTo = String(data.get("cod_period_to") || data.get("cod_period_from") || "").trim();
            const submittedBy = String(data.get("submitter_name") ?? "").trim();
            if (!stationCode || !date || !remittanceCode || !amountRaw) {
              setOk(false);
              setMessage("Select a station and fill deposit date, remittance code, and amount before checking.");
              return;
            }
            if (!codPeriodFrom) {
              setOk(false);
              setMessage("Fill COD From (and COD To) before checking — they must cover remittance creation date.");
              return;
            }
            startTransition(async () => {
              setMessage(null);
              setOk(null);
              try {
                const response = await fetch("/api/ops-pulse/cod/cash-recon/remittance/verify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    stationCode,
                    date,
                    remittanceCode,
                    amount: Number(amountRaw.replace(/,/g, "")),
                    codPeriodFrom,
                    codPeriodTo: codPeriodTo || codPeriodFrom,
                    submittedBy: submittedBy || undefined,
                    fresh: true
                  })
                });
                const payload = await response.json().catch(() => ({})) as VerifyResponse;
                if (!response.ok) {
                  setOk(false);
                  setMessage(payload.error || "Unable to verify remittance.");
                  return;
                }
                if (payload.verified) {
                  setOk(true);
                  setMessage(
                    "Remittance verified — deposit date = submissionDate, COD period covers creationDate, amount and submitter match."
                  );
                  return;
                }
                setOk(false);
                if (payload.failureReason) {
                  setMessage(payload.failureReason);
                } else if (!payload.codeFound) {
                  setMessage("Remittance code not found on Amazon portal for this station.");
                } else {
                  setMessage("Remittance could not be verified.");
                }
              } catch (error) {
                setOk(false);
                setMessage(error instanceof Error ? error.message : "Unable to verify remittance.");
              }
            });
          }}
        >
          {pending ? "Checking…" : "Check remittance"}
        </button>
        {ok != null ? (
          <span className={`status-pill ${ok ? "good" : "warn"}`}>{ok ? "Verified" : "Not verified"}</span>
        ) : null}
      </div>
      {message ? <p className="subtle" style={{ margin: 0 }}>{message}</p> : null}
    </div>
  );
}

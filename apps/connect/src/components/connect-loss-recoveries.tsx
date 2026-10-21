"use client";

import { useCallback, useEffect, useState } from "react";

type Recovery = {
  month: string;
  caseKey: string;
  report: string;
  stationCode: string;
  reason: string;
  assignedAmount: number;
  recoveryMode: string;
  installmentCount: number | null;
  monthlyAmount: number;
  deducted: number;
  outstanding: number;
  status: string;
  lifecycleStatus: string | null;
  nextDueMonth: string | null;
  capOverride: boolean;
  finalSettlement: boolean;
};

const money = (n: number) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ConnectLossRecoveries({
  accountId,
  profileType,
}: {
  accountId: string;
  profileType: string;
}) {
  const [rows, setRows] = useState<Recovery[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({ accountId, profileType });
      const response = await fetch(`/api/connect/loss-recoveries?${q}`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load loss recoveries.");
      setRows(Array.isArray(body.recoveries) ? body.recoveries : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load loss recoveries.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [accountId, profileType]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitClarification(row: Recovery) {
    if (note.trim().length < 10) {
      setError("Explain the clarification in at least 10 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/connect/loss-recoveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          profileType,
          month: row.month,
          caseKey: row.caseKey,
          note: note.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to submit clarification.");
      setNote("");
      setActive(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit clarification.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;
  if (!rows.length && !error) return null;

  return (
    <section className="dx-loss-recoveries" aria-label="Loss recoveries on your pay">
      <header>
        <h2>Loss recoveries</h2>
        <p>
          Assigned Ops loss deductions on your People payroll or Workforce payout. You can acknowledge or
          request clarification; you cannot change the plan.
        </p>
      </header>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      <ul>
        {rows.map((row) => {
          const key = `${row.month}:${row.caseKey}`;
          return (
            <li key={key}>
              <strong>
                {row.reason} · {row.caseKey}
              </strong>
              <small>
                {row.stationCode} · {row.recoveryMode === "installments" ? `Instalments (${row.installmentCount || "—"})` : "Full recovery"} · Status {row.status}
                {row.lifecycleStatus ? ` · ${row.lifecycleStatus}` : ""}
              </small>
              <p>
                Assigned {money(row.assignedAmount)} · Deducted {money(row.deducted)} · Outstanding{" "}
                {money(row.outstanding)}
                {row.nextDueMonth ? ` · Next due ${row.nextDueMonth}` : ""}
                {row.capOverride ? " · Cap override applied" : ""}
                {row.finalSettlement ? " · Final settlement" : ""}
              </p>
              {active === key ? (
                <div>
                  <label>
                    Clarification note
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      maxLength={4000}
                    />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void submitClarification(row)}>
                    Submit clarification
                  </button>
                  <button type="button" disabled={busy} onClick={() => setActive(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setActive(key)}>
                  Request clarification
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectDialog } from "./connect-dialog";

type Recovery = {
  month: string;
  caseKey: string;
  tid: string;
  tidApproximate?: boolean;
  report: string;
  stationCode: string;
  reason: string;
  category: string | null;
  subCategory: string | null;
  impactDate: string | null;
  period: string | null;
  remarks: string | null;
  daName: string | null;
  caseAmount: number;
  assignedAmount: number;
  myShareAmount: number;
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
  outcomeLabel: string | null;
};

const money = (n: number) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (value: string) => {
  if (!/^\d{4}-\d{2}$/.test(value)) return value;
  return new Date(`${value}-01T12:00:00+05:30`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
};

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

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
  const [detail, setDetail] = useState<Recovery | null>(null);
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
          Assigned Ops loss deductions on your People payroll or Workforce payout. Open a case for month,
          tracking ID and details. You can request clarification; you cannot change the plan.
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
                {row.reason} · TID {row.tid || row.caseKey}
              </strong>
              <small>
                {monthLabel(row.month)} · {row.stationCode} ·{" "}
                {row.recoveryMode === "installments"
                  ? `Instalments (${row.installmentCount || "—"})`
                  : "Full recovery"}{" "}
                · Status {row.status}
              </small>
              <p>
                Your share {money(row.myShareAmount)} · Deducted {money(row.deducted)} · Outstanding{" "}
                {money(row.outstanding)}
                {row.nextDueMonth ? ` · Next due ${monthLabel(row.nextDueMonth)}` : ""}
              </p>
              <div className="dx-loss-recoveries-actions">
                <button type="button" onClick={() => setDetail(row)}>
                  View details
                </button>
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
              </div>
            </li>
          );
        })}
      </ul>
      {detail ? (
        <ConnectDialog
          className="dx-loss-recovery-modal"
          eyebrow={`${String(detail.report || "loss").toUpperCase()} · ${detail.stationCode}`}
          title="Loss recovery details"
          onClose={() => setDetail(null)}
        >
          <dl className="dx-loss-recovery-detail">
            <DetailRow label="Loss month" value={monthLabel(detail.month)} />
            <DetailRow
              label="Tracking ID"
              value={detail.tidApproximate ? `${detail.tid} (approximate)` : detail.tid}
            />
            <DetailRow label="Case" value={detail.caseKey} />
            <DetailRow label="Reason" value={detail.reason} />
            <DetailRow label="Category" value={detail.category} />
            <DetailRow label="Sub-category" value={detail.subCategory} />
            <DetailRow label="Impact date" value={detail.impactDate} />
            <DetailRow label="Period" value={detail.period} />
            <DetailRow label="Associate named on case" value={detail.daName} />
            <DetailRow label="Outcome" value={detail.outcomeLabel} />
            <DetailRow label="Case amount" value={money(detail.caseAmount)} />
            <DetailRow label="Your share" value={money(detail.myShareAmount)} />
            <DetailRow
              label="Recovery plan"
              value={
                detail.recoveryMode === "installments"
                  ? `Instalments (${detail.installmentCount || "—"}) · ${money(detail.monthlyAmount)} / month`
                  : "Full recovery"
              }
            />
            <DetailRow label="Deducted so far" value={money(detail.deducted)} />
            <DetailRow label="Outstanding" value={money(detail.outstanding)} />
            <DetailRow
              label="Next due month"
              value={detail.nextDueMonth ? monthLabel(detail.nextDueMonth) : null}
            />
            <DetailRow label="Status" value={detail.status} />
            <DetailRow label="Lifecycle" value={detail.lifecycleStatus} />
            <DetailRow
              label="Notes"
              value={
                [
                  detail.remarks,
                  detail.capOverride ? "Salary cap override applied" : null,
                  detail.finalSettlement ? "Final settlement" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              }
            />
          </dl>
          <p className="dx-loss-recovery-detail-note">
            The payslip shows one Loss Recovery Deduction for the month. Salary Calculation lists each case
            split separately.
          </p>
        </ConnectDialog>
      ) : null}
    </section>
  );
}

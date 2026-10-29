"use client";
import { useEffect, useState } from "react";
import { ConnectDialog } from "./connect-dialog";

export type Recovery = {
  deductions?: {key:string;month:string;amount:number;confirmed:boolean}[];
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
  approvalStatus?: string | null;
  lifecycleStatus: string | null;
  scheduledFromMonth: string | null;
  inPayroll: number;
  waived: number;
  lastDeductedMonth: string | null;
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

export function RecoveryDetail({ detail, onClose, payrollAmount, payrollLabel }: { detail: Recovery; onClose: () => void; payrollAmount?: number; payrollLabel?: string }) {
      return (
        <ConnectDialog
          className="dx-loss-recovery-modal"
          eyebrow={`${String(detail.report || "loss").toUpperCase()} · ${detail.stationCode}`}
          title="Loss recovery details"
          onClose={onClose}
        >
          {payrollAmount != null ? <p className="dx-loss-recovery-detail-note"><strong>{money(payrollAmount)}</strong> included in this {payrollLabel || "payroll"} deduction. This is already included in net pay.</p> : null}
          <dl className="dx-loss-recovery-detail">
            <DetailRow label="Shipment ID" value={detail.tidApproximate ? `${detail.tid} (approximate)` : detail.tid} />
            <DetailRow label="Loss month" value={monthLabel(detail.month)} />
            <DetailRow label="Case value" value={money(detail.caseAmount)} />
            <DetailRow label="Your share" value={money(detail.myShareAmount)} />
            <DetailRow label="Deducted in confirmed payroll" value={money(detail.deducted)} />
            <DetailRow label="Outstanding" value={money(detail.outstanding)} />
            {detail.inPayroll > 0 ? <DetailRow label="In draft payroll · provisional" value={money(detail.inPayroll)} /> : null}
            {detail.waived > 0 ? <DetailRow label="Written off" value={money(detail.waived)} /> : null}
          </dl>
          {detail.status === "redispute_won" ? <p className="dx-loss-recovery-detail-note">Redispute won. Further recovery has stopped. Any earlier deductions remain in your history; this does not record a refund.</p> : detail.status === "redispute_pending" ? <p className="dx-loss-recovery-detail-note">Redispute in progress. Further recovery is paused.</p> : detail.approvalStatus && detail.approvalStatus !== "approved" ? <p className="dx-loss-recovery-detail-note">This assignment is awaiting review and is not a confirmed payroll deduction.</p> : null}
          {detail.deductions?.length ? <details open><summary>Payroll deduction history · {detail.deductions.length}</summary><dl className="dx-loss-recovery-detail">{detail.deductions.map(d=><DetailRow key={d.key} label={`${monthLabel(d.month)} · ${d.confirmed?"Confirmed":"Draft"}`} value={money(d.amount)}/>)}</dl></details> : null}
          <details>
            <summary>Recovery plan and reason</summary>
            <dl className="dx-loss-recovery-detail">
              <DetailRow label="Reason" value={detail.reason} />
              <DetailRow label="Recovery plan" value={detail.recoveryMode === "installments" ? `${detail.installmentCount || "—"} instalments · ${money(detail.monthlyAmount)} / month` : "Full recovery"} />
              <DetailRow label="Eligible from salary month" value={detail.scheduledFromMonth ? monthLabel(detail.scheduledFromMonth) : null} />
              <DetailRow label="Last deduction month" value={detail.lastDeductedMonth ? monthLabel(detail.lastDeductedMonth) : null} />
              <DetailRow label="Status" value={detail.status.replaceAll("_", " ")} />
              <DetailRow label="Outcome" value={detail.outcomeLabel} />
              <DetailRow label="Notes" value={detail.remarks} />
            </dl>
          </details>
          <p className="dx-loss-recovery-detail-note">Approved recoveries reduce net pay in the eligible payroll calculation. Remaining amounts carry forward; completed deductions are not charged again.</p>
        </ConnectDialog>
      );
}

/** Fetch only after a person opens a deduction; the API rechecks their own account. */
export function RecoveryDetailButton({ accountId, profileType, recoveryKey, amount, payrollLabel }: {
  accountId: string; profileType: string; recoveryKey: string; amount: number; payrollLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Recovery | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let disposed = false;
    setDetail(null); setError("");
    const [month, caseKey] = recoveryKey.split("|");
    const q = new URLSearchParams({ accountId, profileType, month, caseKey });
    fetch(`/api/connect/loss-recoveries?${q}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load recovery details.");
        const row = body.recoveries?.find((r: Recovery) => r.month === month && r.caseKey === caseKey);
        if (!row) throw new Error("Case details are unavailable. The amount recorded in your payroll is unchanged.");
        if (!disposed) setDetail(row);
      })
      .catch(e => { if (!disposed) setError(controller.signal.aborted ? "This is taking longer than usual. Please retry." : e.message); })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [open, attempt, accountId, profileType, recoveryKey]);
  return <>
    <button type="button" className="dx-recovery-detail-link" onClick={() => setOpen(true)}>View loss details</button>
    {open ? detail ? <RecoveryDetail detail={detail} onClose={() => setOpen(false)} payrollAmount={amount} payrollLabel={payrollLabel}/>
      : <ConnectDialog title="Loss recovery details" onClose={() => setOpen(false)}>
        {error ? <p role="alert">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry</button></p> : <p role="status">Loading loss details…</p>}
      </ConnectDialog> : null}
  </>;
}

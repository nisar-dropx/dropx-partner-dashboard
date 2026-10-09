"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type RecoveryMethod = "payout_deduction" | "post_invoice_dispute";

type EligibleTarget = {
  dropxId: string;
  name: string;
  category: "Workforce" | "Employee" | "Independent Contractor";
  targetType: "workforce" | "employee" | "contractor";
  targetId: string;
  payoutRunPersonId?: string | null;
  locationId: string | null;
  location: string;
  payoutSource: "Workforce payout" | "People payroll";
  payoutStatus: string;
  isEditable: boolean;
  lockReason: string;
  availableAmount: number;
};

type EligibleResponse = {
  error?: string;
  months?: string[];
  month?: string;
  targets?: EligibleTarget[];
};

type ConfigureResponse = {
  error?: string;
  message?: string;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_SELECTED_IDS = 50;

function money(value: number) {
  return `Rs ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})/);
  if (!match) return value || "—";
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${MONTH_NAMES[month - 1]}-${match[1].slice(-2)}` : value;
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `The server returned an unreadable response (HTTP ${response.status}).` } as T;
  }
}

export function PaymentRecoveryConfigurator({ caseId, onCancel, tid, value }: {
  caseId: string;
  onCancel: () => void;
  tid: string;
  value: number;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<RecoveryMethod | "">("");
  const [months, setMonths] = useState<string[]>([]);
  const [payoutMonth, setPayoutMonth] = useState("");
  const [targets, setTargets] = useState<EligibleTarget[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loadingMonths, setLoadingMonths] = useState(true);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function loadMonths() {
      setLoadingMonths(true);
      try {
        const response = await fetch("/api/payments/recoveries/eligible-payouts", {
          cache: "no-store",
          signal: controller.signal
        });
        const payload = await readResponse<EligibleResponse>(response);
        if (!response.ok) throw new Error(payload.error ?? "Unable to load payroll months.");
        setMonths(payload.months ?? []);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load payroll months.");
      } finally {
        if (!controller.signal.aborted) setLoadingMonths(false);
      }
    }
    loadMonths();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (method !== "payout_deduction" || !payoutMonth) {
      setTargets([]);
      setSelectedIds([]);
      setQuery("");
      return;
    }
    const controller = new AbortController();
    async function loadTargets() {
      setLoadingTargets(true);
      setError("");
      setTargets([]);
      setSelectedIds([]);
      try {
        const response = await fetch(`/api/payments/recoveries/eligible-payouts?month=${encodeURIComponent(payoutMonth)}`, {
          cache: "no-store",
          signal: controller.signal
        });
        const payload = await readResponse<EligibleResponse>(response);
        if (!response.ok) throw new Error(payload.error ?? "Unable to load eligible payout IDs.");
        setTargets(payload.targets ?? []);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load eligible payout IDs.");
      } finally {
        if (!controller.signal.aborted) setLoadingTargets(false);
      }
    }
    loadTargets();
    return () => controller.abort();
  }, [method, payoutMonth]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleTargets = useMemo(() => {
    const term = query.trim().toLowerCase();
    return targets.filter((target) => !term || [
      target.dropxId,
      target.name,
      target.category,
      target.location,
      target.payoutSource,
      target.payoutStatus,
      target.lockReason
    ].some((valuePart) => valuePart.toLowerCase().includes(term)));
  }, [query, targets]);

  function toggleTarget(dropxId: string) {
    if (!targets.some((target) => target.dropxId === dropxId && target.isEditable)) return;
    if (selectedSet.has(dropxId)) {
      setSelectedIds((current) => current.filter((item) => item !== dropxId));
      return;
    }
    if (selectedIds.length >= MAX_SELECTED_IDS) {
      setError(`Select at most ${MAX_SELECTED_IDS} DropX IDs for one TID.`);
      return;
    }
    setError("");
    setSelectedIds((current) => [...current, dropxId]);
  }

  async function applyConfiguration() {
    if (!method) {
      setError("Select a recovery method.");
      return;
    }
    if (method === "payout_deduction" && (!payoutMonth || !selectedIds.length)) {
      setError("Select a payroll month and at least one eligible DropX ID.");
      return;
    }
    if (selectedIds.length > MAX_SELECTED_IDS) {
      setError(`Select at most ${MAX_SELECTED_IDS} DropX IDs for one TID.`);
      return;
    }
    const confirmed = method === "payout_deduction"
      ? window.confirm(
        `Deduct ${money(value)} for TID ${tid} equally from ${selectedIds.length} selected ${selectedIds.length === 1 ? "payout" : "payouts"} in ${monthLabel(payoutMonth)}?\n\nThis action posts the recovery now and cannot be remapped afterward.`
      )
      : window.confirm(
        `Save post-invoice provider dispute as the recovery method for TID ${tid}?\n\nThis records the selected method but does not submit an external provider dispute.`
      );
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payments/recoveries/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          method,
          payoutMonth: method === "payout_deduction" ? payoutMonth : "",
          dropxIds: method === "payout_deduction" ? selectedIds : []
        })
      });
      const payload = await readResponse<ConfigureResponse>(response);
      if (!response.ok) throw new Error(payload.error ?? "Unable to configure this recovery.");
      onCancel();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to configure this recovery.");
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label={`Configure recovery ${tid}`} className="compensation-import-panel">
    <div className="panel-head"><div><h3>Configure recovery · {tid}</h3><p className="subtle">Choose one recovery method. Once applied, this row becomes read-only.</p></div><button className="button secondary compact" disabled={busy} onClick={onCancel} type="button">Cancel</button></div>
    <div className="compensation-import-body">
      <div className="compensation-import-controls">
        <label><span>Recovery method</span><select className="field" disabled={busy} onChange={(event) => { setMethod(event.target.value as RecoveryMethod | ""); setPayoutMonth(""); setError(""); }} value={method}><option value="">Select method</option><option value="payout_deduction">Deduct from payout</option><option value="post_invoice_dispute">Post-invoice provider dispute</option></select></label>
        {method === "payout_deduction" ? <label><span>Payroll month</span><select className="field" disabled={busy || loadingMonths} onChange={(event) => { setPayoutMonth(event.target.value); setError(""); }} value={payoutMonth}><option value="">{loadingMonths ? "Loading months…" : "Select payroll month"}</option>{months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}</select></label> : null}
      </div>

      {method === "payout_deduction" && payoutMonth ? <div className="workforce-advance-filter-panel">
        <label className="workforce-advance-filter-field workforce-advance-search-filter"><span>Search eligible DropX IDs</span><input className="field" disabled={loadingTargets || busy} onChange={(event) => setQuery(event.target.value)} placeholder="DropX ID, name, category or location" type="search" value={query} /></label>
        <div className="workforce-advance-filter-field"><span>Selected (maximum {MAX_SELECTED_IDS})</span><strong>{selectedIds.length.toLocaleString("en-IN")} IDs</strong></div>
        <button className="button secondary compact" disabled={!selectedIds.length || busy} onClick={() => setSelectedIds([])} type="button">Clear selection</button>
      </div> : null}

      {method === "payout_deduction" && payoutMonth ? <div aria-label={`Eligible payouts for ${monthLabel(payoutMonth)}`} className="multi-select-options" role="group">
        {loadingTargets ? <p className="subtle">Loading exact-month payout rows…</p> : visibleTargets.map((target) => <label className={`multi-select-option ${selectedSet.has(target.dropxId) ? "selected" : ""}`} key={`${target.targetType}-${target.targetId}-${target.payoutRunPersonId ?? "dynamic"}-${target.dropxId}`}>
          <input checked={selectedSet.has(target.dropxId)} disabled={busy || !target.isEditable || (!selectedSet.has(target.dropxId) && selectedIds.length >= MAX_SELECTED_IDS)} onChange={() => toggleTarget(target.dropxId)} type="checkbox" />
          <span><strong>{target.dropxId} · {target.name}</strong><small>{target.category} · {target.location} · {target.payoutSource}{target.payoutStatus ? ` · ${target.payoutStatus}` : ""} · Available {money(target.availableAmount)}</small>{!target.isEditable ? <small>{target.lockReason || "This payout is locked and cannot receive a recovery."}</small> : null}</span>
        </label>)}
        {!loadingTargets && !visibleTargets.length ? <p className="subtle">No payout rows match this month and search.</p> : null}
      </div> : null}

      {error ? <div className="compensation-import-message error" role="alert"><strong>Cannot apply recovery</strong><span>{error}</span></div> : null}
      <div className="compensation-commit-row"><span>{method === "payout_deduction" ? "The value is split equally across the selected DropX IDs and deducted from this payroll month." : method === "post_invoice_dispute" ? "This saves the provider-dispute route without posting a payout deduction." : "Select how this value should be recovered."}</span><button className="button" disabled={busy || !method || (method === "payout_deduction" && (!payoutMonth || !selectedIds.length || loadingTargets))} onClick={applyConfiguration} type="button">{busy ? "Applying…" : method === "payout_deduction" ? "Confirm and deduct" : "Save method"}</button></div>
    </div>
  </section>;
}

"use client";
import { LossCaseResponse } from "./loss-case-response";
import { commonOpenPayrollMonths } from "@/lib/ops-pulse/loss-open-payroll";
import { LossCaseRow, LossCaseColumns } from "./loss-case-row";
import { useEffect, useMemo, useState } from "react";
import { FleetMultiSelect } from "./fleet-multi-select";
import "./loss-list-controls.css";
import { useRouter } from "next/navigation";
import {
  type NlCase,
  type Recovery,
  type RecoveryOutcome,
  type RecoveryPerson,
  type LossSettings,
  splitRecovery,
  recoveryNeedsReview,
  recoveryPending,
  recoveryCsv,
  allocationError,
  installmentSchedule,
  monthLabel,
  type RecoveryDetails,
  type RecoveryPlan,
} from "@/lib/ops-pulse/nl-loss-policy";
import { eligibleInstallmentCounts } from "@/lib/ops-pulse/loss-exceptions";
import { sortLossRows, LOSS_SORTS } from "@/lib/ops-pulse/loss-list-controls";
import { TrackingDetailModal } from "./tracking-detail-modal";
import { recoveryActionAllowed, departedPersonError, receivedRecoveryError } from "@/lib/ops-pulse/loss-recovery-controls";
import { recoveryDetailsUpdated } from "@/lib/ops-pulse/loss-final-summary";
import { LossPidTimeline } from "./loss-pid-timeline";
import styles from "./nl-loss.module.css";
import { ListPager, usePaged } from "./list-pager";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
function addMonths(month: string, n: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
const shortMonth = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
function planSummary(r: Recovery) {
  if (r.recovery_mode !== "installments") return "Full debit";
  return r.installment_basis === "months"
    ? `Recurring debit · ${Number(r.installment_value)} months`
    : `Recurring debit · ${money(Number(r.installment_value))} a month`;
}
export function NlLossCases({
  cases,
  outcomes,
  settings,
  canEdit,
  canRecovered = false,
  canApprove = false,
  showPeriod = false,
  initialStatus = "pending",
}: {
  cases: NlCase[];
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
  /** May use restricted outcomes such as "Already recovered". */
  canRecovered?: boolean;
  /** SLP / Loss Recovery Master may final-approve a proposed plan. */
  canApprove?: boolean;
  showPeriod?: boolean;
  initialStatus?: string;
}) {
  const [tracking, setTracking] = useState<{ id: string; station: string } | null>(null);
  const [sort, setSort] = useState("value_desc");
  const [status, setStatus] = useState(initialStatus === "updated" ? "updated" : ["all", "recoverable"].includes(initialStatus) ? "all" : "pending");
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [active, setActive] = useState<string | null>(null);
  const shown = useMemo(
    () =>
      sortLossRows(cases.filter((c) =>
        (status === "all" || (status === "updated") === recoveryDetailsUpdated(c,c.recovery,c.report === "slp")) &&
        [
          c.station_code,
          ...(c.recovery?.allocations.map(p => `${p.full_name} ${p.employee_code}`) || []),
          c.details.tid,
          c.details.da_name,
          c.details.category,
          c.details.sub_category,
          c.recovery?.outcome_label,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      ), sort),
    [cases, query, sort, status],
  );
  const paged = usePaged(shown, 25, `${query}:${sort}:${status}`);
  const current = paged.rows;
  function download() {
    const columns = [
      "Month",
      "Station",
      "Shipment ID",
      "Loss reason",
      "Sub reason",
      "Amazon decision",
      "Recoverable value",
      "Recovery outcome",
      "Deduction month",
      "Recovery method",
      "Monthly amount",
      "Instalments",
      "Re-dispute reason",
      "Detailing",
      "CCTV link",
      "Employee ID",
      "Employee name",
      "Individual amount",
      "Remarks",
      "Updated by",
      "Updated at",
    ];
    const rows = shown.flatMap((c) => {
      const r = c.recovery && !c.recovery.is_deleted ? c.recovery : null;
      return (r?.allocations.length ? r.allocations : [null]).map((p) => [
        c.month,
        c.station_code,
        c.details.tid,
        c.details.category,
        c.details.sub_category,
        c.source_status,
        c.amount,
        r?.outcome_label || "Pending update",
        r?.deduction_month,
        r ? planSummary(r) : "",
        p?.monthly_amount ?? p?.amount,
        p?.installments?.length || (p ? 1 : ""),
        r?.recovery_details?.reason,
        r?.recovery_details?.details,
        r?.recovery_details?.cctv_url,
        p?.employee_code,
        p?.full_name,
        p?.amount,
        r?.remarks,
        r?.updated_by_name,
        r?.updated_at,
      ]);
    });
    const url = URL.createObjectURL(
      new Blob(
        [
          "\ufeff" +
            [columns, ...rows]
              .map((r) => r.map(recoveryCsv).join(","))
              .join("\r\n"),
        ],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `nl-recovery-${cases[0]?.month ?? "month"}-${cases[0]?.station_code ?? "station"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className={styles.panel}>
      <TrackingDetailModal trackingId={tracking?.id ?? null} stationHint={tracking?.station} onClose={() => setTracking(null)} />
      <div className={styles.panelHead}>
        <div>
          <h2>Recoverable cases</h2>
          <p>
            {shown.length} cases ·{" "}
            {cases.filter((c) => recoveryPending(c.recovery)).length}{" "}
            pending update
          </p>
        </div>
        <div className={styles.toolbar}>
          <select aria-label="Recovery status" value={status} onChange={e=>setStatus(e.target.value)}><option value="pending">Pending update</option><option value="updated">Updated</option><option value="all">All recovery cases</option></select>
          <select aria-label="Sort recovery cases" value={sort} onChange={e=>setSort(e.target.value)}>{LOSS_SORTS.filter(o=>o.value!=="cases_desc").map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <input
            aria-label="Search recovery cases"
            placeholder="Search Shipment ID, person or reason"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          <button className={styles.button} onClick={download}>
            Download CSV
          </button>
        </div>
      </div>
      <LossCaseColumns/>
      <div className={styles.cases}>
        {current.map((c) => (
          <article key={`${c.month}:${c.case_key}`} className={styles.case}>
            <LossCaseRow station={c.station_code} tid={c.details.tid || c.case_key} approximate={!c.details.tid || c.details.tid_approximate}
              reason={[showPeriod?c.details.period||c.month:"",c.details.category||"Unspecified reason",c.details.sub_category].filter(Boolean).join(" · ")}
              value={money(c.amount)} date={c.recovery?.updated_at} updatedBy={c.recovery?.updated_by_name} historyCase={{month:c.month,caseKey:c.case_key}} open={active === c.month+":"+c.case_key}
              onTrack={() => setTracking({id:c.details.tid!,station:c.station_code})} onToggle={() => setActive(active===c.month+":"+c.case_key?null:c.month+":"+c.case_key)}
              status={<span className={recoveryDetailsUpdated(c,c.recovery,c.report==="slp")?styles.done:styles.pending}>{recoveryNeedsReview(c)?"Review needed":recoveryDetailsUpdated(c,c.recovery,c.report==="slp")?"Details updated":"Pending update"}{c.recovery&&!c.recovery.is_deleted?" · "+c.recovery.outcome_label:""}</span>}/>
            {active === `${c.month}:${c.case_key}` ? (
              <RecoveryForm
                row={c}
                outcomes={outcomes}
                settings={settings}
                canEdit={canEdit}
                canRecovered={canRecovered}
                canApprove={canApprove}
              />
            ) : null}
          </article>
        ))}
      </div>
      {!shown.length ? (
        <p className={styles.empty}>No recoverable cases match your search.</p>
      ) : null}
      <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={(n) => { paged.setPage(n); setActive(null); }} onSize={(n) => { paged.setSize(n); setActive(null); }} label="cases" />
    </section>
  );
}
export function RecoveryForm({
  row,
  outcomes,
  settings,
  canEdit: mayEdit,
  canRecovered,
  canApprove = false,
  onSaved,
}: {
  row: NlCase;
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
  canRecovered: boolean;
  canApprove?: boolean;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const old = row.recovery && !row.recovery.is_deleted ? row.recovery : null;
  const [recovery, setRecovery] = useState(row.recovery),
    [outcome, setOutcome] = useState(old?.outcome_code || ""),
    [mode, setMode] = useState<"equal" | "custom">(
      old?.split_mode === "custom" && settings?.allow_custom_split
        ? "custom"
        : settings?.allow_equal_split
          ? "equal"
          : "custom",
    ),
    [remarks, setRemarks] = useState(old?.remarks || "");
  const [plan, setPlan] = useState<RecoveryPlan>({
    deduction_month: old?.deduction_month || "",
    mode: old?.recovery_mode || "full",
    basis: old?.installment_basis || "months",
    value:
      old?.installment_value != null
        ? String(Number(old.installment_value))
        : "3",
  });
  const policy = settings?.recovery_policy;
  const capEnabled = true;
  const capPercent = 100;
  const maxInstallments = Number(policy?.max_installments) || 24;
  const [details, setDetails] = useState<RecoveryDetails>(
    old?.recovery_details || {},
  );
  const [caseKey, setCaseKey] = useState(row.case_key);
  const [deductionMonths, setDeductionMonths] = useState<
    Record<string, string>
  >({});
  const [awaitingFinal, setAwaitingFinal] = useState(false);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryError, setSalaryError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [people, setPeople] = useState<RecoveryPerson[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>(
      old?.allocations.map((p) => p.ref) || [],
    ),
    [amounts, setAmounts] = useState<Record<string, string>>(
      Object.fromEntries(
        old?.allocations.map((p) => [p.ref, String(p.amount)]) || [],
      ),
    );
  /** Custom split: keep amount fields for selected people; fill a sole person with the full loss. */
  function selectPeople(ids: string[]) {
    setSelected(ids);
    const unpaid = commonOpenPayrollMonths(people, ids);
    if (ids.some(ref => people.find(p => p.ref === ref)?.is_active === false) && unpaid.length && !unpaid.includes(deductionPeriod)) {
      setPlan(p => ({...p, mode:"full", deduction_month:unpaid[0]}));
    }
    setAmounts((prev) => {
      const next: Record<string, string> = {};
      for (const ref of ids) next[ref] = prev[ref] ?? "";
      if (mode === "custom" && ids.length === 1) {
        const ref = ids[0]!;
        if (!next[ref] || Number(next[ref]) <= 0) next[ref] = String(row.amount);
      }
      return next;
    });
  }
  // Opened cases load only their station directory and history; no company-wide people payload.
  const [retry, setRetry] = useState(0);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [canPropose, setCanPropose] = useState(false);
  const [mayApproveCase,setMayApproveCase]=useState(false);
  const [canResponse, setCanResponse] = useState(false);
  const [showRedispute, setShowRedispute] = useState(false);
  const [exceptionOptions,setExceptionOptions] = useState<{installments:boolean;next_month:string|null}>({installments:false,next_month:null});
  const [returnNote, setReturnNote] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => { controller.abort(); }, 90000);
    setLoading(true);
    setDirectoryReady(false);
    setError("");
    void (async () => {
      try {
        const res = await fetch(
          `/api/ops-pulse/losses/recovery?month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(row.case_key)}&directory=1`,
          { cache: "no-store", signal: controller.signal },
        );
        const j = await res.json();
        if (!res.ok) throw Error(j.error);
        if (Number(j.amount) !== Number(row.amount))
          throw Error(
            "The loss amount changed. Refresh the case list before allocating recovery.",
          );
        setCaseKey(j.case_key);
        setDeductionMonths(j.deduction_months);
        setAwaitingFinal(!!j.awaiting_final);
        setPeople(j.people);
        setCanPropose(j.can_propose === true);
        setCanResponse(j.can_response === true);
        setExceptionOptions(j.exception_options || {installments:false,next_month:null});
        setMayApproveCase(j.can_approve === true);
        setDirectoryReady(true);
      } catch (e) {
        if (!disposed) setError(controller.signal.aborted ? "Station salary checks took too long. Reload to retry; no recovery has been changed." : e instanceof Error ? e.message : "Could not load recovery.");
      } finally {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [row.month, row.case_key, retry]);
  const option = outcomes.find((o) => o.code === outcome);
  const deductionPeriod = plan.deduction_month || deductionMonths[option?.deduction_timing || "current_month"];
  const [designationFilter,setDesignationFilter] = useState("");
  const selectedKey = [...selected].sort().join(",");
  useEffect(() => {
    if (!directoryReady || !selectedKey || !deductionPeriod) return;
    const controller = new AbortController();
    setSalaryLoading(true);
    setSalaryError("");
    const timeout = setTimeout(() => {
      setSalaryError("Salary check timed out. Reload to retry.");
      setSalaryLoading(false);
      controller.abort();
    }, 45000);
    const params = new URLSearchParams({ month: row.month, case: row.case_key, payroll_month: deductionPeriod });
    selectedKey.split(",").forEach(ref => params.append("person", ref));
    fetch(`/api/ops-pulse/losses/recovery?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async res => { const j = await res.json(); if (!res.ok) throw Error(j.error); return j; })
      .then(j => {
        if (controller.signal.aborted) return;
        setPeople(current => current.map(p => j.people.find((checked: RecoveryPerson) => checked.ref === p.ref) ?? p));
        if (selectedKey.split(",").some(ref => !j.people.some((p: RecoveryPerson) => p.ref === ref)))
          setSalaryError("A selected person is not eligible for payroll recovery. Review their employment details.");
      })
      .catch(e => { if (!controller.signal.aborted) setSalaryError(e.message || "Salary check failed. Reload to retry."); })
      .finally(() => { clearTimeout(timeout); if (!controller.signal.aborted) setSalaryLoading(false); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [directoryReady, selectedKey, row.month, row.case_key, retry, deductionPeriod]);
  // A restricted plan (e.g. "Already recovered") can only be changed by people who may set it.
  const savedOutcome =
    recovery && !recovery.is_deleted
      ? outcomes.find((o) => o.code === recovery.outcome_code)
      : undefined;
  const locked = !!savedOutcome?.restricted && !canRecovered;
  const canEdit = mayEdit && canPropose && !locked;
  const splits =
    mode === "equal"
      ? splitRecovery(row.amount, selected)
      : selected.map((employee_ref) => ({
          employee_ref,
          amount: Number(amounts[employee_ref] || 0),
        }));
  const installmentCounts = eligibleInstallmentCounts(splits.length ? splits.map(s=>s.amount) : [row.amount], policy);
  const recurringEnabled = exceptionOptions.installments || old?.recovery_mode === "installments" && old?.approval_status === "approved";
  const total =
    splits.reduce((n, r) => n + Math.round(r.amount * 100), 0) / 100;
  const available = people.filter(
    (p) =>
      selected.includes(p.ref) ||
      `${p.full_name} ${p.employee_code} ${p.designation} ${(p.station_codes || []).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const validation = outcome === "responsible_left" ? departedPersonError(details, remarks) : !option?.is_active || !recoveryActionAllowed(option)
    ? "Select an active recovery action."
    : option.allocation_required
      ? allocationError(
          row.amount,
          splits,
          people,
          capEnabled,
          plan,
          maxInstallments,
          capPercent,
          policy,
        )
      : "";
  const limitOf = (p: RecoveryPerson) =>
    p.recovery_limit;
  const reasonError =
    option?.dispute_fields_enabled &&
    ((option.reason_required && (details.reason || "").trim().length < 5) ||
      (option.details_required && (details.details || "").trim().length < 5) ||
      (details.cctv_url &&
        settings?.recovery_policy.cctv_public_confirmation &&
        !details.cctv_public_confirmed));
  const receiptError = outcome === "already_recovered" ? receivedRecoveryError(details, Number(row.amount)) : "";
  const cannotSave = !!receiptError ||
    (option?.allocation_required && (salaryLoading || !!salaryError)) ||
    !!validation ||
    !!reasonError ||
    (option?.remarks_required && remarks.trim().length < 5) ||
    !directoryReady;
  async function upload(files: FileList | null) {
    if (!files || !settings) return;
    if (
      (details.attachments?.length || 0) + files.length >
      settings.recovery_policy.attachment_max_count
    ) {
      setError(
        `Maximum ${settings.recovery_policy.attachment_max_count} attachments.`,
      );
      return;
    }
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        form.set("month", row.month);
        form.set("case", caseKey);
        form.set("outcome", outcome);
        const response = await fetch(
          "/api/ops-pulse/losses/recovery/attachments",
          { method: "POST", body: form },
        );
        const value = await response.json();
        if (!response.ok) throw Error(value.error);
        setDetails((d) => ({
          ...d,
          attachments: [...(d.attachments || []), value.attachment],
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment upload failed.");
    } finally {
      setUploading(false);
    }
  }
  const attachmentUrl = (id: string) =>
    `/api/ops-pulse/losses/recovery/attachments?month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(caseKey)}&id=${encodeURIComponent(id)}`;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (cannotSave || uploading) {
      setError(
        receiptError ||
          validation ||
          (reasonError
            ? "Complete the required re-dispute reason or detailing before saving."
            : "") ||
          (option?.remarks_required && remarks.trim().length < 5
            ? "Enter remarks (at least 5 characters) before saving."
            : "") ||
          (option?.allocation_required && salaryLoading
            ? "Wait for salary limits to finish loading, then save."
            : "") ||
          (option?.allocation_required && salaryError
            ? salaryError
            : "") ||
          "Complete all required recovery details before saving.",
      );
      return;
    }
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const res = await fetch("/api/ops-pulse/losses/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: row.month,
          case_key: caseKey,
          version: recovery?.version || 0,
          outcome,
          split_mode: option?.allocation_required ? mode : "none",
          allocations: option?.allocation_required ? splits : [],
          plan: option?.allocation_required
            ? plan.mode === "installments"
              ? {...plan,deduction_month:deductionPeriod}
              : {
                  mode: "full",
                  deduction_month: deductionPeriod,
                }
            : { mode: "full" },
          remarks,
          recovery_details: option?.dispute_fields_enabled || ["responsible_left", "already_recovered"].includes(outcome) ? details : {},
        }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.error);
      setRecovery(j.recovery);
      setSuccess(canResponse ? "Recovery plan saved. Payroll remains paused while the redispute is active." : j.recovery.approval_status === "approved" ? (j.payroll_sync?.message || "Saved for payroll. The full recovery will be included in the applicable payroll calculation.") : "Exception submitted for approval. Payroll stays paused until another authorised approver confirms it.");
      if(onSaved)onSaved();else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (
      !window.confirm(
        "Remove this recovery plan? Its history will remain available.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/ops-pulse/losses/recovery", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: row.month,
          case_key: caseKey,
          version: recovery?.version,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.error);
      setRecovery(j.recovery);
      setOutcome("");
      setSelected([]);
      setAmounts({});
      setRemarks("");
      setDetails({});
      setSuccess(`Plan removed. History is preserved.${j.payroll_sync?.message ? " " + j.payroll_sync.message : ""}`);
      if(onSaved)onSaved();else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove plan.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.detail}>

      <details className={styles.compactDetails}><summary>Source details · {row.month}</summary>
      <div className={styles.sourceGrid}>
        <div>
          <small>{row.report === "slp" ? "Recovery file" : "Amazon decision"}</small>
          <strong>{row.source_status}</strong>
        </div>
        <div>
          <small>Loss file month</small>
          <strong>{row.month}</strong>
        </div>
        <div>
          <small>Source DA</small>
          <strong>{row.details.da_name || "Not provided"}</strong>
        </div>
        <div>
          <small>Source file</small>
          <span>{row.source_file}</span>
        </div>
      </div>
      {row.details.extra?.nl_res || row.details.remarks ? (
        <p className={styles.sourceNote}>
          {row.details.extra?.nl_res || row.details.remarks}
        </p>
      ) : null}
      </details>
      {recoveryNeedsReview({ ...row, recovery }) ? (
        <p className={styles.notice}>
          Amazon’s amount or decision changed since the saved plan. Review and
          save the correct allocation again.
        </p>
      ) : null}
      {["proposed","needs_review"].includes(recovery?.approval_status || "") ? (
        <p className={styles.notice}>
          Exception awaiting approval. Payroll is paused until independently confirmed.
          {canApprove && mayApproveCase ? (
            <>
              {" "}
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  setSuccess("");
                  try {
                    const res = await fetch("/api/ops-pulse/losses/lifecycle", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "approve",
                        month: row.month,
                        case_key: caseKey,
                        version: recovery?.version || 0,
                        lifecycle_version:
                          (row as { lifecycle_version?: number })
                            .lifecycle_version ?? 1,
                      }),
                    });
                    const j = await res.json();
                    if (!res.ok) throw Error(j.error);
                    setRecovery(j.recovery);
                    setSuccess("Update approved. Scheduled balances remain outstanding until collected.");
                    if(onSaved)onSaved();else router.refresh();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Approval could not be completed.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Approve update
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {recovery?.approval_status === "returned" || row.lifecycle_status === "returned_to_station" ? <p className={styles.notice}>Returned for update: {recovery?.approval_note || row.lifecycle_note}. Correct the details and submit again.</p> : null}
      {canApprove && mayApproveCase && recovery && ["proposed", "needs_review"].includes(recovery.approval_status || "") && !["recovered", "written_off", "not_recoverable"].includes(row.lifecycle_status || "") ? <details className={styles.compactDetails}><summary>Return for correction</summary>
        <textarea aria-label="Reason for return" value={returnNote} onChange={e => setReturnNote(e.target.value)} minLength={10} maxLength={2000} rows={2} placeholder="What must the station correct?" />
        <button className={styles.button} disabled={busy || returnNote.trim().length < 10} onClick={async () => {
          if (!recovery) return;
          setBusy(true); setError(""); try {
            const res = await fetch("/api/ops-pulse/losses/lifecycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "return_to_station", month: row.month, case_key: caseKey, version: row.lifecycle_version, note: returnNote }) });
            const j=await res.json(); if(!res.ok) throw Error(j.error); setReturnNote(""); setRecovery({...recovery,approval_status:"returned",approval_note:returnNote}); setSuccess("Returned for correction. Resubmission needs final approval again."); if(onSaved)onSaved();else router.refresh();
          } catch(e) {setError(e instanceof Error?e.message:"Return failed.");} finally {setBusy(false);}
        }}>Return update</button>
      </details> : null}
      {error ? (
        <p role="alert" className={styles.failure}>
          <strong>Could not save recovery.</strong> {error}{" "}
          <button
            type="button"
            className={styles.button}
            onClick={() => setRetry((n) => n + 1)}
          >
            Reload
          </button>
        </p>
      ) : null}
      {success ? (
        <p role="status" className={styles.done}>
          {success}
        </p>
      ) : null}
      {locked ? (
        <p className={styles.notice}>
          Marked “{savedOutcome?.label}” by {recovery?.updated_by_name}. Only
          people with that access can change this plan.
        </p>
      ) : null}
      {!loading && directoryReady && mayEdit && !canPropose ? <p className={styles.notice}>You have view access to this recovery.</p> : null}
      {loading ? (
        <p role="status">Loading recovery…</p>
      ) : showRedispute && canResponse ? (
        <>
          <label>Recovery action<select aria-label="Recovery action" value="__redispute" onChange={()=>setShowRedispute(false)}><option value="__redispute">Redispute · evidence &amp; status</option><option value="recovery">Update recovery plan</option></select></label>
          <LossCaseResponse month={row.month} caseKey={caseKey} embedded/>
        </>
      ) : (
        <form onSubmit={save}>
          <fieldset
            disabled={!canEdit || busy || uploading || !directoryReady}
            className={`${styles.fieldset} ${styles.recoveryForm}`}
          >
            <label>
              Recovery action
              <select
                value={outcome}
                onChange={(e) => {
                  if(e.target.value==="__redispute"){setShowRedispute(true);return;}
                  setOutcome(e.target.value);
                  setPlan(p=>({...p,deduction_month:outcomes.find(o=>o.code===e.target.value)?.deduction_timing==="next_month" ? exceptionOptions.next_month || undefined : deductionMonths.current_month}));
                  setSuccess("");
                }}
                required
              >
                <option value="">Select an outcome</option>
                {canResponse?<option value="__redispute">Redispute · evidence &amp; status</option>:null}
                {outcomes
                  .filter(
                    (o) =>
                      (o.is_active && recoveryActionAllowed(o) && !o.restricted && (o.deduction_timing !== "next_month" || !!exceptionOptions.next_month)) ||
                      o.code === outcome,
                  )
                  .map((o) => (
                    <option key={o.code} value={o.code} disabled={!o.is_active || !recoveryActionAllowed(o)}>
                      {o.label}
                      {!o.is_active ? " (removed)" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {outcome === "already_recovered" ? <div className={styles.departedFields}>
              <label>Amount received<input required type="number" min="0.01" step="0.01" value={details.received_amount || ""} onChange={e=>setDetails({...details,received_amount:e.target.value})}/></label>
              <label>Receipt / payment reference<input required minLength={5} maxLength={160} value={details.receipt_reference || ""} onChange={e=>setDetails({...details,receipt_reference:e.target.value})}/></label>
              <label>Received date<input required type="date" value={details.received_date || ""} onChange={e=>setDetails({...details,received_date:e.target.value})}/></label>
              {receiptError?<small>{receiptError}</small>:<small>Submitted for independent verification; no payroll deduction is created.</small>}
            </div> : null}
            {outcome === "responsible_left" ? <div className={styles.departedFields}>
              <label>Employee ID<input required value={details.employee_id || ""} maxLength={80} onChange={e => setDetails({ ...details, employee_id: e.target.value })} /></label>
              <label>Full name<input required value={details.employee_name || ""} maxLength={160} onChange={e => setDetails({ ...details, employee_name: e.target.value })} /></label>
              <label>Recovery owner &amp; next step<textarea required rows={2} maxLength={1000} placeholder="Who will follow up, by when, and how will the balance be recovered?" value={details.follow_up || ""} onChange={e => setDetails({ ...details, follow_up: e.target.value })} /></label>
              <small>Departure does not close the loss. The full balance remains outstanding.</small>
            </div> : null}
            {option?.allocation_required ? <label>Recovery payroll month<select value={deductionPeriod || ""} onChange={e=>setPlan({...plan,deduction_month:e.target.value})}>{[...new Set([deductionMonths.current_month, exceptionOptions.next_month, old?.deduction_month, ...commonOpenPayrollMonths(people,selected)].filter(Boolean))].sort().map(m=><option key={m} value={m!}>{monthLabel(m!)}{m===exceptionOptions.next_month ? ' · enabled exception' : m===deductionMonths.current_month ? ' · current payroll' : commonOpenPayrollMonths(people,selected).includes(m!) ? ' · unpaid payroll open' : ' · existing schedule'}</option>)}</select><small>Unpaid months remain selectable until payroll closes. Later-month recovery needs an enabled exception.</small></label> : null}
            {option?.allocation_required ? (
              <div className={styles.allocation}>
                <div className={styles.toolbar}>
                  <label>
                    Split method
                    <select
                      value={mode}
                      onChange={(e) => {
                        const next = e.target.value as "equal" | "custom";
                        setMode(next);
                        if (next === "custom" && selected.length === 1) {
                          const ref = selected[0]!;
                          setAmounts((a) =>
                            !a[ref] || Number(a[ref]) <= 0
                              ? { ...a, [ref]: String(row.amount) }
                              : a,
                          );
                        }
                      }}
                    >
                      {settings?.allow_equal_split ? (
                        <option value="equal">Split equally</option>
                      ) : null}
                      {settings?.allow_custom_split ? (
                        <option value="custom">Enter individual amounts</option>
                      ) : null}
                    </select>
                  </label>
                  <label>Designation<select value={designationFilter} onChange={e=>setDesignationFilter(e.target.value)}><option value="">All designations</option>{[...new Set(people.map(p=>p.designation))].sort().map(d=><option key={d}>{d}</option>)}</select></label>
                  <div className="loss-multi-filter"><FleetMultiSelect label="Recovery person" allLabel="Select names" alwaysSearch options={people.filter(p=>selected.includes(p.ref)||!designationFilter||p.designation===designationFilter).map(p=>({value:p.ref,label:p.full_name,helper:`${p.employee_code} · ${p.designation}${p.station_codes?.length ? ` · ${p.station_codes.join(" / ")}` : ""}${p.is_active?'':' · Left'}${p.open_payroll_months?.length && !p.is_active ? ` · unpaid ${p.open_payroll_months.map(monthLabel).join(", ")}` : ""}`}))} values={selected} onChange={selectPeople}/></div>
                </div>
                <div
                  className={styles.methods}
                  role="radiogroup"
                  aria-label="Recovery method"
                >
                  <label className={styles.method}>
                    <input
                      type="radio"
                      name={`method-${row.case_key}`}
                      checked={plan.mode === "full"}
                      onChange={() => setPlan({ ...plan, mode: "full" })}
                    />
                    <strong>Full debit</strong>

                  </label>
                  {recurringEnabled ? <label className={styles.method}>
                    <input
                      type="radio"
                      disabled={!installmentCounts.length && old?.recovery_mode !== "installments"}
                      name={`method-${row.case_key}`}
                      checked={plan.mode === "installments"}
                      onChange={() =>
                        setPlan({ ...plan, mode: "installments", basis:"months", value:String(installmentCounts[0] || 2) })
                      }
                    />
                    <strong>Recurring debit</strong>

                  </label> : null}
                </div>
                {recurringEnabled && !installmentCounts.length ? <p className={styles.hint}>The selected recovery shares do not qualify for recurring debit under the amount rules. Use Full debit.</p> : null}
                {plan.mode === 'installments' ? <div className={styles.planRow}>
                  <label>Calculate each person's schedule by<select value={plan.basis} onChange={e=>setPlan({...plan,basis:e.target.value as RecoveryPlan['basis'],value:e.target.value==='months'?String(installmentCounts[0]||''):''})}><option value="months">Equal split over payroll months</option><option value="amount">Fixed amount per person per month</option></select></label>
                  <label>{plan.basis==='months'?'Number of monthly deductions':'Monthly amount per person (₹)'}
                    {plan.basis==='months'?<select value={plan.value} onChange={e=>setPlan({...plan,value:e.target.value})}><option value="">Choose eligible months</option>{[...new Set([...installmentCounts,...(old?.recovery_mode==='installments' && old.installment_basis==='months'?[Number(old.installment_value)]:[])])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n} monthly deductions{!installmentCounts.includes(n)?' · existing schedule':''}</option>)}</select>:<input type="number" min="1" step="0.01" value={plan.value} onChange={e=>setPlan({...plan,value:e.target.value})} placeholder="Monthly deduction per person"/>}
                  </label>
                  <p className={styles.hint}>{plan.basis==='months'?'Each person’s allocated share is divided equally; any rounding paise are added to the first deductions.':'This amount is deducted from each selected person every payroll month. The final deduction is the remaining balance.'} Review each person's amounts and final payroll below. Missed payrolls move the remaining deductions forward.</p>
                </div>:null}
                {plan.mode === 'installments' && policy?.installment_thresholds_enabled ? <small className={styles.hint}>Per person: 2 months above {money(Number(policy.installment_two_month_min))}; 3 above {money(Number(policy.installment_three_month_min))}; each extra month requires another {money(Number(policy.installment_extra_month_step))}. The enabled exception and salary limits are checked on save.</small>:null}
                <details className={styles.compactDetails}><summary>Recovery rules</summary><p className={styles.hint}>
                  Eligible station DAs and People staff, using the current debit-scope rules in Master.
                  {capEnabled
                    ? ` Recovery uses available pay after other recoveries; unpaid lines carry forward.`
                    : ""}
                  {plan.mode === "installments"
                    ? " A missed month moves the remaining instalments on. If a person exits, the balance is recovered in their final settlement."
                    : ""}
                </p></details>
                {salaryLoading && selected.length > 0 ? <p role="status" className={styles.hint}>Checking salary limits for selected people…</p> : null}
                {salaryError ? <p role="alert" className={styles.failure}>{salaryError}</p> : null}
                {!search.trim() && !selected.length ? <p className={styles.hint}>Select station staff, DAs, or the mapped Cluster Manager / AOM.</p> : null}
                <div className={styles.people}>
                  {available.filter(p => selected.includes(p.ref)).map((p) => (
                    <div className={styles.person} key={p.ref}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(p.ref)}
                          onChange={(e) =>
                            selectPeople(
                              e.target.checked
                                ? [...selected, p.ref]
                                : selected.filter((id) => id !== p.ref),
                            )
                          }
                        />
                        <span>
                          <strong>{p.full_name}</strong>
                          <small>
                            {p.employee_code} · {p.designation}{p.station_codes?.length ? ` · ${p.station_codes.join(" / ")}` : ""}
                            {!p.is_active ? " · Inactive / left" : ""}
                          </small>
                          <small className={deductionPeriod && deductionPeriod < deductionMonths.current_month ? styles.earlierSalary : undefined}>From {deductionPeriod ? monthLabel(deductionPeriod) : 'selected'} salary{deductionPeriod && deductionPeriod < deductionMonths.current_month ? ' · Earlier payroll' : ''}{plan.mode === 'installments' ? ' · first instalment' : ''}</small>
                          {capEnabled && p.pay_detail_access !== "restricted" && selected.includes(p.ref) ? (
                            <small className={p.recovery_limit == null ? styles.pending : styles.payFacts}>
                              {p.recovery_limit == null
                                ? "Payout payable unavailable · review payout / mapping"
                                : p.unpaid_payroll_check ? `${p.salary_month ? monthLabel(p.salary_month) : "Selected payroll"} · max recovery ${money(p.recovery_limit)}` : `${p.salary_month ? monthLabel(p.salary_month) : "Selected payout"}: payable ${money(p.salary_payable ?? 0)} · available ${money(limitOf(p) ?? 0)}`}
                            </small>
                          ) : null}
                          {selected.includes(p.ref) &&
                          plan.mode === "installments" ? (
                            <SchedulePreview
                              amount={
                                splits.find((s) => s.employee_ref === p.ref)
                                  ?.amount || 0
                              }
                              plan={plan}
                              maxInstallments={maxInstallments}
                              firstMonth={deductionPeriod || ""}
                              label={`Schedule for ${p.employee_code}`}
                            />
                          ) : null}
                        </span>
                      </label>
                      {selected.includes(p.ref) ? (
                        mode === "custom" ? (
                          <label className={styles.personAmount}>
                            <span>Amount (₹)</span>
                            <span className={styles.amountWrap}>
                              <input
                                aria-label={`Recovery amount in rupees for ${p.employee_code}`}
                                inputMode="decimal"
                                type="number"
                                min="0.01"
                                max={
                                  capEnabled && plan.mode === "full" && p.pay_detail_access !== "restricted"
                                    ? (limitOf(p) ?? undefined)
                                    : undefined
                                }
                                step="0.01"
                                placeholder="0.00"
                                value={amounts[p.ref] || ""}
                                onChange={(e) =>
                                  setAmounts((a) => ({
                                    ...a,
                                    [p.ref]: e.target.value,
                                  }))
                                }
                              />
                            </span>
                          </label>
                        ) : (
                          <strong className={styles.personShare}>
                            {money(
                              splits.find((s) => s.employee_ref === p.ref)
                                ?.amount || 0,
                            )}
                          </strong>
                        )
                      ) : null}
                    </div>
                  ))}
                </div>
                {!people.length ? (
                  <p role="alert" className={styles.failure}>
                    No Station Manager-or-below employees with IDs are linked to
                    this station. Update People or Workforce mapping first.
                  </p>
                ) : null}
                {validation && selected.length ? (
                  <p role="alert" className={styles.failure}>
                    {validation}
                  </p>
                ) : null}
                <div className={styles.splitTotal}>
                  <span>{selected.length} people selected</span>
                  <strong>
                    Allocated {money(total)} / {money(row.amount)}
                  </strong>
                  {Math.round(total * 100) !== Math.round(row.amount * 100) ? (
                    <span className={styles.balanceGap}>
                      Still to allocate {money(row.amount - total)}
                    </span>
                  ) : (
                    <span className={styles.balanceOk}>Full amount allocated</span>
                  )}
                </div>
              </div>
            ) : null}
            {option?.dispute_fields_enabled ? (
              <section className={styles.allocation}>
                <h3>Re-dispute details</h3>
                <label>
                  Reason for re-dispute{" "}
                  {option.reason_required ? "(required)" : "(optional)"}
                  <textarea
                    rows={2}
                    maxLength={2000}
                    minLength={option.reason_required ? 5 : undefined}
                    required={option.reason_required}
                    value={details.reason || ""}
                    onChange={(e) =>
                      setDetails({ ...details, reason: e.target.value })
                    }
                  />
                </label>
                <label>
                  Detailing{" "}
                  {option.details_required ? "(required)" : "(optional)"}
                  <textarea
                    rows={4}
                    maxLength={10000}
                    minLength={option.details_required ? 5 : undefined}
                    required={option.details_required}
                    value={details.details || ""}
                    onChange={(e) =>
                      setDetails({ ...details, details: e.target.value })
                    }
                  />
                </label>
                {option.attachments_enabled ? (
                  <label>
                    Attachments (optional)
                    <input
                      type="file"
                      multiple
                      accept={settings?.recovery_policy.attachment_types.join(
                        ",",
                      )}
                      onChange={(e) => {
                        void upload(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <small>
                      Up to {settings?.recovery_policy.attachment_max_count}{" "}
                      files · {settings?.recovery_policy.attachment_max_mb} MB
                      each
                    </small>
                  </label>
                ) : null}
                {uploading ? <p role="status">Uploading evidence…</p> : null}
                {details.attachments?.map((a) => (
                  <div className={styles.toolbar} key={a.id}>
                    <a
                      href={attachmentUrl(a.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.file_name}
                    </a>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() =>
                        setDetails({
                          ...details,
                          attachments: details.attachments?.filter(
                            (f) => f.id !== a.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {option.cctv_enabled ? (
                  <>
                    <label>
                      CCTV link (optional)
                      <input
                        type="url"
                        pattern="https://.*"
                        value={details.cctv_url || ""}
                        onChange={(e) =>
                          setDetails({
                            ...details,
                            cctv_url: e.target.value,
                            cctv_public_confirmed: false,
                          })
                        }
                        placeholder="https://drive.google.com/…"
                      />
                    </label>
                    <p className={styles.hint}>
                      Set link sharing to “Anyone with the link can view” before
                      adding it.
                    </p>
                    {details.cctv_url &&
                    settings?.recovery_policy.cctv_public_confirmation ? (
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          required
                          checked={!!details.cctv_public_confirmed}
                          onChange={(e) =>
                            setDetails({
                              ...details,
                              cctv_public_confirmed: e.target.checked,
                            })
                          }
                        />
                        I confirmed anyone with the link can view this CCTV
                        recording.
                      </label>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
            <label>
              Remarks {option?.remarks_required ? "(required)" : "(optional)"}
              <textarea
                maxLength={2000}
                rows={1}
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                required={option?.remarks_required}
                placeholder="Record the reason and follow-up for this recovery."
              />
            </label>
            {canEdit ? (
              <button
                className={styles.primary}
                disabled={busy || uploading || cannotSave}
              >
                {busy
                  ? "Saving…"
                  : recovery && !recovery.is_deleted
                    ? "Update recovery"
                    : "Save recovery"}
              </button>
            ) : (
              <p className={styles.hint}>
                {locked
                  ? "This plan is locked."
                  : "Losses edit access is required to update this plan."}
              </p>
            )}
            {canEdit && recovery && !recovery.is_deleted ? (
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => void clear()}
              >
                Remove recovery plan
              </button>
            ) : null}
          </fieldset>
        </form>
      )}
      <LossPidTimeline month={row.month} caseKey={row.case_key} revision={recovery?.version || 0}/>
    </div>
  );
}
function SchedulePreview({
  amount,
  plan,
  maxInstallments,
  firstMonth,
  label,
}: {
  amount: number;
  plan: RecoveryPlan;
  maxInstallments: number;
  firstMonth: string;
  label: string;
}) {
  const schedule = installmentSchedule(amount, plan, maxInstallments).schedule;
  if (!schedule.length) return null;
  const last = schedule[schedule.length - 1];
  return (
    <span className={styles.schedule} aria-label={label}>
      <strong>{schedule.length} deduction{schedule.length === 1 ? "" : "s"} · total {money(amount)} · final {money(last)}</strong>
      {schedule.length <= 6 ? (
        schedule.map((value, i) => (
          <span key={i}>
            {firstMonth ? shortMonth(addMonths(firstMonth, i)) : `#${i + 1}`} ·{" "}
            {money(value)}
          </span>
        ))
      ) : (
        <span>
          {schedule.length} × {money(schedule[0])}
          {last !== schedule[0] ? ` (last ${money(last)})` : ""}
          {firstMonth
            ? ` · ${shortMonth(firstMonth)} → ${shortMonth(addMonths(firstMonth, schedule.length - 1))}`
            : ""}
        </span>
      )}
    </span>
  );
}

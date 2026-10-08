"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type NlCase,
  type Recovery,
  type RecoveryOutcome,
  type RecoveryPerson,
  type LossSettings,
  splitRecovery,
  recoveryNeedsReview,
  recoveryCsv,
  allocationError,
  monthLabel,
  type RecoveryDetails,
} from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
type History = {
  id: string;
  actor_name: string;
  created_at: string;
  after_value: Recovery;
};
export function NlLossCases({
  cases,
  outcomes,
  settings,
  canEdit,
  canRecovered = false,
  showPeriod = false,
}: {
  cases: NlCase[];
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
  /** May use restricted outcomes such as "Already recovered". */
  canRecovered?: boolean;
  showPeriod?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [active, setActive] = useState<string | null>(null);
  const shown = useMemo(
    () =>
      cases.filter((c) =>
        [
          c.details.tid,
          c.details.da_name,
          c.details.category,
          c.details.sub_category,
          c.recovery?.outcome_label,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [cases, query],
  );
  const pages = Math.ceil(shown.length / 15);
  const current = shown.slice(page * 15, page * 15 + 15);
  function download() {
    const columns = [
      "Month",
      "Station",
      "TID",
      "Loss reason",
      "Sub reason",
      "Amazon decision",
      "Recoverable value",
      "Recovery outcome",
      "Deduction month",
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
      <div className={styles.panelHead}>
        <div>
          <h2>Recoverable cases</h2>
          <p>
            {shown.length} cases ·{" "}
            {cases.filter((c) => !c.recovery || c.recovery.is_deleted).length}{" "}
            pending update
          </p>
        </div>
        <div className={styles.toolbar}>
          <input
            aria-label="Search recovery cases"
            placeholder="Search TID, person or reason"
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
      <div className={styles.cases}>
        {current.map((c) => (
          <article key={c.case_key} className={styles.case}>
            <button
              className={styles.caseSummary}
              aria-expanded={active === c.case_key}
              onClick={() =>
                setActive(active === c.case_key ? null : c.case_key)
              }
            >
              <div>
                <strong>
                  {c.details.tid_approximate ? "≈ " : ""}
                  {c.details.tid || c.case_key}
                </strong>
                <span>
                  {showPeriod && c.details.period ? `${c.details.period} · ` : ""}
                  {c.details.category || "Unspecified reason"}
                  {c.details.sub_category ? ` · ${c.details.sub_category}` : ""}
                </span>
                {c.report === "slp" &&
                c.details.final_published &&
                !c.details.in_final ? (
                  <span className={styles.pending}>
                    Not in the Final file · confirm before recovering
                  </span>
                ) : null}
              </div>
              <div>
                <strong>{money(c.amount)}</strong>
                <span
                  className={
                    c.recovery && !c.recovery.is_deleted
                      ? styles.done
                      : styles.pending
                  }
                >
                  {recoveryNeedsReview(c)
                    ? "Source changed · review"
                    : c.recovery && !c.recovery.is_deleted
                      ? c.recovery.outcome_label
                      : "Recovery update pending"}
                </span>
              </div>
              <span aria-hidden>{active === c.case_key ? "−" : "+"}</span>
            </button>
            {active === c.case_key ? (
              <RecoveryForm
                row={c}
                outcomes={outcomes}
                settings={settings}
                canEdit={canEdit}
                canRecovered={canRecovered}
              />
            ) : null}
          </article>
        ))}
      </div>
      {!shown.length ? (
        <p className={styles.empty}>No recoverable cases match your search.</p>
      ) : null}
      {pages > 1 ? (
        <div className={styles.pagination}>
          <button
            className={styles.button}
            disabled={!page}
            onClick={() => {
              setPage(page - 1);
              setActive(null);
            }}
          >
            Previous
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            className={styles.button}
            disabled={page >= pages - 1}
            onClick={() => {
              setPage(page + 1);
              setActive(null);
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}
function RecoveryForm({
  row,
  outcomes,
  settings,
  canEdit: mayEdit,
  canRecovered,
}: {
  row: NlCase;
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
  canRecovered: boolean;
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
  const [details, setDetails] = useState<RecoveryDetails>(
    old?.recovery_details || {},
  );
  const [caseKey, setCaseKey] = useState(row.case_key);
  const [deductionMonths, setDeductionMonths] = useState<
    Record<string, string>
  >({});
  const [uploading, setUploading] = useState(false);
  const [people, setPeople] = useState<RecoveryPerson[]>([]),
    [history, setHistory] = useState<History[]>([]),
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
  // Opened cases load only their station directory and history; no company-wide people payload.
  const [retry, setRetry] = useState(0);
  const [directoryReady, setDirectoryReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDirectoryReady(false);
    setError("");
    void (async () => {
      try {
        const res = await fetch(
          `/api/ops-pulse/losses/recovery?month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(row.case_key)}`,
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
        setPeople(j.people);
        setHistory(j.history);
        setDirectoryReady(true);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load recovery.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [row.month, row.case_key, retry]);
  const option = outcomes.find((o) => o.code === outcome);
  // A restricted plan (e.g. "Already recovered") can only be changed by people who may set it.
  const savedOutcome =
    recovery && !recovery.is_deleted
      ? outcomes.find((o) => o.code === recovery.outcome_code)
      : undefined;
  const locked = !!savedOutcome?.restricted && !canRecovered;
  const canEdit = mayEdit && !locked;
  const quick = canRecovered
    ? outcomes.find((o) => o.restricted && o.is_active && o.code !== outcome)
    : undefined;
  const splits =
    mode === "equal"
      ? splitRecovery(row.amount, selected)
      : selected.map((employee_ref) => ({
          employee_ref,
          amount: Number(amounts[employee_ref] || 0),
        }));
  const total =
    splits.reduce((n, r) => n + Math.round(r.amount * 100), 0) / 100;
  const available = people.filter(
    (p) =>
      selected.includes(p.ref) ||
      `${p.full_name} ${p.employee_code} ${p.designation}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const deductionPeriod =
    recovery &&
    !recovery.is_deleted &&
    recovery.deduction_timing === option?.deduction_timing &&
    recovery.deduction_month
      ? recovery.deduction_month
      : deductionMonths[option?.deduction_timing || "none"];
  const validation = !option?.is_active
    ? "Select an active recovery action."
    : option.allocation_required
      ? allocationError(
          row.amount,
          splits,
          people,
          settings?.recovery_policy.salary_cap_enabled,
        )
      : "";
  const reasonError =
    option?.dispute_fields_enabled &&
    ((option.reason_required && (details.reason || "").trim().length < 5) ||
      (option.details_required && (details.details || "").trim().length < 5) ||
      (details.cctv_url &&
        settings?.recovery_policy.cctv_public_confirmation &&
        !details.cctv_public_confirmed));
  const cannotSave =
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
      setError(validation || "Complete all required details before saving.");
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
          remarks,
          recovery_details: option?.dispute_fields_enabled ? details : {},
        }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.error);
      setRecovery(j.recovery);
      setHistory((h) => [
        {
          id: String(Date.now()),
          actor_name: j.recovery.updated_by_name,
          created_at: j.recovery.updated_at,
          after_value: j.recovery,
        },
        ...h,
      ]);
      setSuccess("Recovery plan saved.");
      router.refresh();
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
      setHistory((h) => [
        {
          id: String(Date.now()),
          actor_name: j.recovery.updated_by_name,
          created_at: j.recovery.updated_at,
          after_value: j.recovery,
        },
        ...h,
      ]);
      setSuccess("Plan removed. History is preserved.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove plan.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.detail}>
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
      {recoveryNeedsReview({ ...row, recovery }) ? (
        <p className={styles.notice}>
          Amazon’s amount or decision changed since the saved plan. Review and
          save the correct allocation again.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}{" "}
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
      {loading ? (
        <p role="status">Loading station employees and recovery history…</p>
      ) : (
        <form onSubmit={save}>
          {canEdit && quick ? (
            <div className={styles.quick}>
              <span>
                Recovered earlier, outside this plan? No employee deduction is
                created.
              </span>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => {
                  setOutcome(quick.code);
                  setSuccess("");
                }}
              >
                {quick.label}
              </button>
            </div>
          ) : null}
          <fieldset
            disabled={!canEdit || busy || uploading || !directoryReady}
            className={styles.fieldset}
          >
            <label>
              Recovery action
              <select
                value={outcome}
                onChange={(e) => {
                  setOutcome(e.target.value);
                  setSuccess("");
                }}
                required
              >
                <option value="">Select an outcome</option>
                {outcomes
                  .filter(
                    (o) =>
                      (o.is_active && (!o.restricted || canRecovered)) ||
                      o.code === outcome,
                  )
                  .map((o) => (
                    <option key={o.code} value={o.code} disabled={!o.is_active}>
                      {o.label}
                      {!o.is_active ? " (removed)" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {option?.allocation_required && deductionPeriod ? (
              <p className={styles.notice}>
                <strong>Deduction month: {monthLabel(deductionPeriod)}</strong>
                <br />
                {option.deduction_timing === "next_month"
                  ? "Next-month exception: record employee IDs, the full amount and the reason now."
                  : "Allocate the full loss amount to the responsible employee IDs."}
              </p>
            ) : null}
            {option?.allocation_required ? (
              <div className={styles.allocation}>
                <div className={styles.toolbar}>
                  <label>
                    Split method
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMode(e.target.value as "equal" | "custom")
                      }
                    >
                      {settings?.allow_equal_split ? (
                        <option value="equal">Split equally</option>
                      ) : null}
                      {settings?.allow_custom_split ? (
                        <option value="custom">Enter individual amounts</option>
                      ) : null}
                    </select>
                  </label>
                  <label>
                    Find station employee
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Name, employee ID or designation"
                    />
                  </label>
                </div>
                <p className={styles.hint}>
                  Eligible station DAs, People staff and mapped managers, using
                  the rules in Master.
                  {settings?.recovery_policy.salary_cap_enabled
                    ? " Each employee is limited to their available previous-month salary payable."
                    : ""}
                </p>
                <div className={styles.people}>
                  {available.map((p) => (
                    <div className={styles.person} key={p.ref}>
                      <label>
                        <input
                          type="checkbox"
                          disabled={
                            !selected.includes(p.ref) &&
                            settings?.recovery_policy.salary_cap_enabled &&
                            (p.recovery_limit == null || p.recovery_limit <= 0)
                          }
                          checked={selected.includes(p.ref)}
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, p.ref]
                                : ids.filter((id) => id !== p.ref),
                            )
                          }
                        />
                        <span>
                          <strong>{p.full_name}</strong>
                          <small>
                            {p.employee_code} · {p.designation}
                            {!p.is_active ? " · Inactive / left" : ""}
                          </small>
                          {settings?.recovery_policy.salary_cap_enabled ? (
                            <small
                              className={
                                p.recovery_limit == null
                                  ? styles.pending
                                  : undefined
                              }
                            >
                              {p.recovery_limit == null
                                ? "Salary payable unavailable · review payroll / mapping"
                                : `Available recovery limit ${money(p.recovery_limit)} · ${p.salary_month ? monthLabel(p.salary_month) : ""}`}
                            </small>
                          ) : null}
                        </span>
                      </label>
                      {selected.includes(p.ref) ? (
                        mode === "custom" ? (
                          <input
                            aria-label={`Amount for ${p.employee_code}`}
                            inputMode="decimal"
                            type="number"
                            min="0.01"
                            max={
                              settings?.recovery_policy.salary_cap_enabled
                                ? (p.recovery_limit ?? 0)
                                : undefined
                            }
                            step="0.01"
                            value={amounts[p.ref] || ""}
                            onChange={(e) =>
                              setAmounts((a) => ({
                                ...a,
                                [p.ref]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <strong>
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
                  <p>
                    No employees with IDs are linked to this station. Update
                    People or Workforce mapping first.
                  </p>
                ) : null}
                {validation && selected.length ? (
                  <p role="alert" className={styles.error}>
                    {validation}
                  </p>
                ) : null}
                <div className={styles.splitTotal}>
                  <span>{selected.length} people selected</span>
                  <strong>
                    Allocated {money(total)} / {money(row.amount)}
                  </strong>
                  {Math.round(total * 100) !== Math.round(row.amount * 100) ? (
                    <span className={styles.error}>
                      Balance {money(row.amount - total)}
                    </span>
                  ) : null}
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
                rows={3}
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
                  : "Read-only access. A cluster manager with Losses edit access can update this plan."}
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
      {history.length ? (
        <details className={styles.history}>
          <summary>
            Recovery history · {history.length} update
            {history.length === 1 ? "" : "s"}
          </summary>
          {history.map((h) => (
            <div key={h.id}>
              <strong>
                {h.after_value.is_deleted
                  ? "Plan removed"
                  : h.after_value.outcome_label}{" "}
                · {h.actor_name}
              </strong>
              <small>
                {new Date(h.created_at).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                })}
              </small>
              {h.after_value.deduction_month ? (
                <p>Deduction: {monthLabel(h.after_value.deduction_month)}</p>
              ) : null}
              <p>{h.after_value.remarks}</p>
              {h.after_value.recovery_details?.reason ? (
                <p>
                  <strong>Reason:</strong>{" "}
                  {h.after_value.recovery_details.reason}
                </p>
              ) : null}
              {h.after_value.recovery_details?.details ? (
                <p>
                  <strong>Detailing:</strong>{" "}
                  {h.after_value.recovery_details.details}
                </p>
              ) : null}
              {h.after_value.recovery_details?.attachments?.map((a) => (
                <p key={a.id}>
                  <a href={attachmentUrl(a.id)}>{a.file_name}</a>
                </p>
              ))}
              {h.after_value.recovery_details?.cctv_url ? (
                <p>
                  <a
                    href={h.after_value.recovery_details.cctv_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    CCTV recording
                  </a>
                </p>
              ) : null}
              {h.after_value.allocations.map((p) => (
                <span key={p.ref}>
                  {p.full_name} ({p.employee_code}) — {money(p.amount)}
                  <br />
                </span>
              ))}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

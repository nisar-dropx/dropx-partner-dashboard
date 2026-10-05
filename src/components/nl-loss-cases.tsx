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
}: {
  cases: NlCase[];
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
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
                  {c.details.category || "Unspecified reason"}
                  {c.details.sub_category ? ` · ${c.details.sub_category}` : ""}
                </span>
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
  canEdit,
}: {
  row: NlCase;
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
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
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const res = await fetch("/api/ops-pulse/losses/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: row.month,
          case_key: row.case_key,
          version: recovery?.version || 0,
          outcome,
          split_mode: option?.allocation_required ? mode : "none",
          allocations: option?.allocation_required ? splits : [],
          remarks,
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
          case_key: row.case_key,
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
          <small>Amazon decision</small>
          <strong>{row.source_status}</strong>
        </div>
        <div>
          <small>Recovery month</small>
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
      {loading ? (
        <p role="status">Loading station employees and recovery history…</p>
      ) : (
        <form onSubmit={save}>
          <fieldset
            disabled={!canEdit || busy || !directoryReady}
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
                  .filter((o) => o.is_active || o.code === outcome)
                  .map((o) => (
                    <option key={o.code} value={o.code} disabled={!o.is_active}>
                      {o.label}
                      {!o.is_active ? " (removed)" : ""}
                    </option>
                  ))}
              </select>
            </label>
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
                  Station DAs, People staff and mapped managers. Select everyone
                  sharing this recovery.
                </p>
                <div className={styles.people}>
                  {available.map((p) => (
                    <div className={styles.person} key={p.ref}>
                      <label>
                        <input
                          type="checkbox"
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
                        </span>
                      </label>
                      {selected.includes(p.ref) ? (
                        mode === "custom" ? (
                          <input
                            aria-label={`Amount for ${p.employee_code}`}
                            inputMode="decimal"
                            type="number"
                            min="0.01"
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
                disabled={busy || !option?.is_active}
              >
                {busy
                  ? "Saving…"
                  : recovery && !recovery.is_deleted
                    ? "Update recovery"
                    : "Save recovery"}
              </button>
            ) : (
              <p className={styles.hint}>
                Read-only access. A cluster manager with Losses edit access can
                update this plan.
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
              <p>{h.after_value.remarks}</p>
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

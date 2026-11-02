"use client";

import { useEffect, useMemo, useState } from "react";
import {
  downloadRecoveryCsv,
  recoveryActionCode,
  recoveryActionLabel,
  RECOVERY_PENDING_ACTION,
} from "@/lib/ops-pulse/nl-recovery-csv";
import type { NlCase, RecoveryOutcome } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

function caseId(c: NlCase) {
  return `${c.month}:${c.case_key}`;
}

function tidLabel(c: NlCase) {
  return String(c.details.tid || c.case_key).trim() || c.case_key;
}

export function NlRecoveryDownloadButton({
  cases,
  month,
  outcomes,
  filePrefix = "nl-recovery",
  label = "Download CSV",
  className,
}: {
  cases: NlCase[];
  month: string;
  outcomes: RecoveryOutcome[];
  filePrefix?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className || styles.button}
        disabled={!cases.length}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? (
        <NlRecoveryDownloadModal
          cases={cases}
          month={month}
          outcomes={outcomes}
          filePrefix={filePrefix}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function NlRecoveryDownloadModal({
  cases,
  month,
  outcomes,
  filePrefix = "nl-recovery",
  onClose,
}: {
  cases: NlCase[];
  month: string;
  outcomes: RecoveryOutcome[];
  filePrefix?: string;
  onClose: () => void;
}) {
  const actionOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const c of cases) {
      const code = recoveryActionCode(c);
      const label = recoveryActionLabel(c);
      const prev = counts.get(code);
      counts.set(code, { label, count: (prev?.count || 0) + 1 });
    }
    const known = outcomes
      .filter((o) => counts.has(o.code))
      .map((o) => ({
        value: o.code,
        label: o.label,
        count: counts.get(o.code)!.count,
        outcome: o,
      }));
    const pending = counts.get(RECOVERY_PENDING_ACTION);
    const extras = [...counts.entries()]
      .filter(
        ([code]) =>
          code !== RECOVERY_PENDING_ACTION &&
          !outcomes.some((o) => o.code === code),
      )
      .map(([code, info]) => ({
        value: code,
        label: info.label,
        count: info.count,
        outcome: null as RecoveryOutcome | null,
      }));
    return [
      { value: "", label: "Any recovery action", count: cases.length, outcome: null as RecoveryOutcome | null },
      ...(pending
        ? [{ value: RECOVERY_PENDING_ACTION, label: "Pending update", count: pending.count, outcome: null }]
        : []),
      ...known,
      ...extras,
    ];
  }, [cases, outcomes]);

  const [action, setAction] = useState("");
  const [tidQuery, setTidQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cases.map(caseId)));
  const [error, setError] = useState("");

  const actionCases = useMemo(
    () => (action ? cases.filter((c) => recoveryActionCode(c) === action) : cases),
    [action, cases],
  );
  const actionCaseKey = useMemo(
    () => actionCases.map(caseId).sort().join("\n"),
    [actionCases],
  );

  useEffect(() => {
    setSelected(new Set(actionCaseKey ? actionCaseKey.split("\n") : []));
    setTidQuery("");
    setError("");
  }, [action, actionCaseKey]);

  const selectedOutcome = actionOptions.find((o) => o.value === action)?.outcome ?? null;

  const visibleTids = useMemo(() => {
    const q = tidQuery.trim().toLowerCase();
    return actionCases.filter((c) => {
      if (!q) return true;
      return [
        c.details.tid,
        c.case_key,
        c.station_code,
        c.details.category,
        recoveryActionLabel(c),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [actionCases, tidQuery]);

  const selectedCases = useMemo(
    () => actionCases.filter((c) => selected.has(caseId(c))),
    [actionCases, selected],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function download() {
    if (!selectedCases.length) {
      setError("Select at least one shipment ID.");
      return;
    }
    const stationPart =
      selectedCases.length === 1
        ? selectedCases[0]!.station_code
        : new Set(selectedCases.map((c) => c.station_code)).size === 1
          ? selectedCases[0]!.station_code
          : "all-stations";
    downloadRecoveryCsv(
      selectedCases,
      `${filePrefix}-${month || selectedCases[0]?.month || "month"}-${stationPart}.csv`,
    );
    onClose();
  }

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`${styles.dialog} ${styles.downloadDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nl-recovery-download-title"
      >
        <div className={styles.panelHead} style={{ padding: 0, border: 0 }}>
          <div>
            <h3 id="nl-recovery-download-title">Download recovery CSV</h3>
            <p className={styles.hint}>
              Choose a recovery action (or any), review its details, then select the shipment IDs to include.
            </p>
          </div>
          <button type="button" className={styles.button} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <label>
          Recovery action
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Recovery action"
          >
            {actionOptions.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label} · {o.count}
              </option>
            ))}
          </select>
        </label>

        {selectedOutcome ? (
          <dl className={styles.dialogFacts} aria-label="Recovery action details">
            <div>
              <dt>Action</dt>
              <dd>{selectedOutcome.label}</dd>
            </div>
            <div>
              <dt>Code</dt>
              <dd>{selectedOutcome.code}</dd>
            </div>
            <div>
              <dt>Allocation</dt>
              <dd>{selectedOutcome.allocation_required ? "People required" : "Not required"}</dd>
            </div>
            <div>
              <dt>Payroll timing</dt>
              <dd>
                {selectedOutcome.deduction_timing === "none"
                  ? "No payroll deduction"
                  : selectedOutcome.deduction_timing === "next_month"
                    ? "Next payroll month"
                    : "Current payroll month"}
              </dd>
            </div>
            <div>
              <dt>Re-dispute fields</dt>
              <dd>
                {selectedOutcome.dispute_fields_enabled
                  ? [
                      selectedOutcome.reason_required ? "reason required" : "reason optional",
                      selectedOutcome.details_required ? "detailing required" : "detailing optional",
                      selectedOutcome.attachments_enabled ? "attachments" : null,
                      selectedOutcome.cctv_enabled ? "CCTV link" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "Hidden"}
              </dd>
            </div>
            <div>
              <dt>Remarks</dt>
              <dd>{selectedOutcome.remarks_required ? "Required" : "Optional"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {selectedOutcome.is_active ? "Active" : "Removed"}
                {selectedOutcome.restricted ? " · restricted" : ""}
              </dd>
            </div>
          </dl>
        ) : action === RECOVERY_PENDING_ACTION ? (
          <p className={styles.hint}>
            Cases with no saved recovery plan yet. The CSV includes empty recovery detail columns for these rows.
          </p>
        ) : (
          <p className={styles.hint}>
            Any action includes every matching case. The CSV always exports full recovery plan details where present.
          </p>
        )}

        <div className={styles.toolbar}>
          <input
            aria-label="Search shipment IDs"
            placeholder="Search shipment ID, station or reason"
            value={tidQuery}
            onChange={(e) => setTidQuery(e.target.value)}
          />
          <button
            type="button"
            className={styles.button}
            onClick={() => setSelected(new Set(visibleTids.map(caseId)))}
            disabled={!visibleTids.length}
          >
            Select shown
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => setSelected(new Set(actionCases.map(caseId)))}
            disabled={!actionCases.length}
          >
            Select all
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => setSelected(new Set())}
            disabled={!selected.size}
          >
            Clear
          </button>
        </div>
        <p className={styles.hint}>
          {selectedCases.length} selected · {visibleTids.length} shown · {actionCases.length} for this action ·{" "}
          {money(selectedCases.reduce((v, c) => v + Number(c.amount || 0), 0))}
        </p>

        <div className={styles.downloadTidList} role="group" aria-label="Shipment IDs">
          {visibleTids.length ? (
            visibleTids.map((c) => {
              const id = caseId(c);
              const checked = selected.has(id);
              return (
                <label key={id} className={checked ? styles.downloadTidSelected : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                  />
                  <span>
                    <strong>{tidLabel(c)}</strong>
                    <small>
                      {c.station_code} · {recoveryActionLabel(c)} · {money(Number(c.amount || 0))}
                      {c.details.category ? ` · ${c.details.category}` : ""}
                    </small>
                  </span>
                </label>
              );
            })
          ) : (
            <p className={styles.empty}>No shipment IDs match this filter.</p>
          )}
        </div>

        {error ? (
          <p role="alert" className={styles.failure}>
            {error}
          </p>
        ) : null}

        <div className={styles.dialogActions}>
          <button type="button" className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={!selectedCases.length}
            onClick={download}
          >
            Download {selectedCases.length || ""} CSV
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";
import { useMemo, useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import {
  compareAuditTids,
  parseAuditTids,
  type AuditEmployee,
} from "@/lib/ops-pulse/station-audit-reconciliation";
import type {
  AuditOption,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import styles from "./audit-workspace.module.css";
export function EmployeePicker({
  name,
  people,
  multiple = false,
  required = false,
  initial = [],
}: {
  name: string;
  people: AuditEmployee[];
  multiple?: boolean;
  required?: boolean;
  initial?: AuditEmployee[];
}) {
  const [selected, setSelected] = useState(initial.map((p) => p.ref));
  const options = people
    .filter((p) => !multiple || !selected.includes(p.ref))
    .map((p) => ({
      value: p.ref,
      label: `${p.employee_code} · ${p.full_name}`,
      helper: `${p.designation}${p.is_active ? "" : " · inactive"}`,
    }));
  return (
    <div>
      <SearchableSelect
        name={multiple ? `${name}_search` : name}
        options={options}
        value={multiple ? "" : selected[0] || ""}
        required={required && !multiple}
        placeholder="Search employee ID or name"
        onValueChange={(ref) =>
          setSelected((old) =>
            multiple ? (ref ? [...old, ref] : old) : ref ? [ref] : [],
          )
        }
      />
      {multiple && (
        <div className={styles.employeeChips}>
          {selected.map((ref) => {
            const p =
              people.find((p) => p.ref === ref) ||
              initial.find((p) => p.ref === ref);
            return (
              <span key={ref}>
                <input type="hidden" name={name} value={ref} />
                {p?.employee_code} · {p?.full_name}
                <button
                  type="button"
                  aria-label={`Remove ${p?.full_name}`}
                  onClick={() =>
                    setSelected((old) => old.filter((v) => v !== ref))
                  }
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {!people.length && (
        <small>
          No station-linked employee IDs available. Update the People/workforce
          station mapping.
        </small>
      )}
    </div>
  );
}
export function ShipmentInspection({
  lists,
  exceptions,
}: {
  lists: { expected: string[]; scanned: string[] } | null;
  exceptions: StationAuditWorkspace["shipments"];
}) {
  const [expected, setExpected] = useState((lists?.expected || []).join("\n"));
  const [scanned, setScanned] = useState((lists?.scanned || []).join("\n"));
  const [scan, setScan] = useState("");
  const [scanNotice, setScanNotice] = useState("");
  const [page, setPage] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>(
    Object.fromEntries(exceptions.map((e) => [e.tracking_id, e.remarks || ""])),
  );
  const result = useMemo(() => {
    try {
      const a = parseAuditTids(expected),
        b = parseAuditTids(scanned);
      return { a, b, ...compareAuditTids(a.ids, b.ids), error: "" };
    } catch (e) {
      return {
        a: { ids: [], duplicates: 0 },
        b: { ids: [], duplicates: 0 },
        missing: [],
        excess: [],
        matched: 0,
        error: e instanceof Error ? e.message : "Check TIDs",
      };
    }
  }, [expected, scanned]);
  const rows = [
    ...result.missing.map((tid) => ({ tid, kind: "Missing" })),
    ...result.excess.map((tid) => ({ tid, kind: "Excess" })),
  ];
  const addScan = () => {
    try {
      const next = parseAuditTids(scan).ids;
      if (next.length !== 1) throw new Error("Scan one shipment at a time.");
      const current = parseAuditTids(scanned).ids;
      if (current.includes(next[0])) {
        setScanNotice(`${next[0]} already scanned`);
      } else {
        setScanned((old) => `${old}${old ? "\n" : ""}${next[0]}`);
        setScanNotice(`${next[0]} added`);
      }
      setScan("");
    } catch (e) {
      setScanNotice(e instanceof Error ? e.message : "Invalid scan");
    }
  };
  return (
    <section className={styles.section} style={{ marginTop: 12 }}>
      <div className={styles.sectionHeader}>
        Shipment reconciliation{" "}
        <span>ERP ageing → physical scan → missing / excess</span>
      </div>
      <div className={styles.sectionBody}>
        <p className={styles.checkHelp}>
          Paste only tracking IDs from the ageing report. Scan every physical
          shipment; duplicate TIDs count once. Counts and differences are
          calculated automatically.
        </p>
        <div className={styles.reconciliationGrid}>
          <div>
            <h3>1. ERP ageing · {result.a.ids.length}</h3>
            <textarea
              aria-label="ERP ageing TIDs"
              name="expected_tids"
              rows={10}
              value={expected}
              onChange={(e) => {
                setExpected(e.target.value);
                setPage(0);
              }}
              placeholder="Paste the tracking-ID column, one TID per line"
            />
            <small>{result.a.duplicates} duplicate entries ignored</small>
          </div>
          <div>
            <h3>2. Physically scanned · {result.b.ids.length}</h3>
            <div className={styles.scanInput}>
              <input
                aria-label="Scan physical shipment"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addScan();
                  }
                }}
                placeholder="Scan barcode, then Enter"
                autoComplete="off"
              />
              <button
                type="button"
                className={styles.miniButton}
                onClick={addScan}
              >
                Add
              </button>
            </div>
            <small role="status">{scanNotice}</small>
            <textarea
              aria-label="Physical scanned TIDs"
              name="scanned_tids"
              rows={8}
              value={scanned}
              onChange={(e) => {
                setScanned(e.target.value);
                setPage(0);
              }}
              placeholder="Scanned TIDs appear here; a scanner export can also be pasted"
            />
            <small>{result.b.duplicates} duplicate entries ignored</small>
          </div>
          <div>
            <h3>3. Differences · {rows.length}</h3>
            <p>
              {result.matched} matched · {result.missing.length} missing ·{" "}
              {result.excess.length} excess
            </p>
            <div className={styles.tidDifferences}>
              {rows.slice(page * 50, page * 50 + 50).map((row) => (
                <label key={row.tid} className={styles.tidRow}>
                  <strong>
                    {row.tid}{" "}
                    <span className={styles.photoBadge}>{row.kind}</span>
                  </strong>
                  <input
                    value={notes[row.tid] || ""}
                    onChange={(e) =>
                      setNotes((old) => ({ ...old, [row.tid]: e.target.value }))
                    }
                    placeholder="Auditor observation (required)"
                    aria-label={`Observation for ${row.tid}`}
                  />
                </label>
              ))}
              {!rows.length && !result.error && (
                <p>No missing or excess TIDs in these lists.</p>
              )}
            </div>
            {rows.length > 50 && (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={!page}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span>
                  {page + 1} / {Math.ceil(rows.length / 50)}
                </span>
                <button
                  type="button"
                  disabled={(page + 1) * 50 >= rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
            <small>
              {rows.filter((r) => notes[r.tid]?.trim()).length}/{rows.length}{" "}
              observations added. The station responds after submission.
            </small>
          </div>
        </div>
        {result.error && (
          <p role="alert" className={styles.notice}>
            {result.error}
          </p>
        )}
        <input type="hidden" name="tid_remarks" value={JSON.stringify(notes)} />
        <label className={styles.confirmLine}>
          <input
            type="checkbox"
            name="shipment_scan_confirmed"
            value="yes"
            required
            disabled={!!result.error}
          />{" "}
          I confirm the ERP ageing list and physical scan are complete,
          including any zero-shipment result.
        </label>
      </div>
    </section>
  );
}
export function ShipmentResponses({
  shipments,
  options,
  people,
}: {
  shipments: StationAuditWorkspace["shipments"];
  options: AuditOption[];
  people: AuditEmployee[];
}) {
  const [states, setStates] = useState<
    Record<string, { status: string; remarks: string }>
  >(
    Object.fromEntries(
      shipments.map((s) => [
        s.id,
        {
          status: s.station_response?.status || "",
          remarks: s.station_response?.remarks || "",
        },
      ]),
    ),
  );
  return (
    <div>
      {shipments
        .filter((s) => !s.is_resolved)
        .map((s) => {
          const state = states[s.id] || { status: "", remarks: "" };
          const option = options.find((o) => o.code === state.status);
          return (
            <fieldset key={s.id} className={styles.shipmentResponse}>
              <legend>
                {s.tracking_id} · {s.discrepancy_code}
              </legend>
              <p className={styles.checkHelp}>{s.remarks}</p>
              <label className={styles.inputLabel}>
                Station status
                <select
                  name={`shipment_status_${s.id}`}
                  required
                  value={state.status}
                  onChange={(e) =>
                    setStates((old) => ({
                      ...old,
                      [s.id]: { ...state, status: e.target.value },
                    }))
                  }
                >
                  <option value="">Select status</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.inputLabel}>
                Remarks
                <textarea
                  name={`shipment_note_${s.id}`}
                  required
                  defaultValue={state.remarks}
                  placeholder="Explain current status and follow-up"
                />
              </label>
              <div className={styles.inputLabel}>
                Employee ID{" "}
                {option?.metadata.requires_employee === true
                  ? "(required)"
                  : "(optional)"}
                <EmployeePicker
                  key={`${s.id}:${state.status}`}
                  name={`shipment_employee_${s.id}`}
                  people={people}
                  required={option?.metadata.requires_employee === true}
                  initial={
                    s.station_response?.employee
                      ? [s.station_response.employee]
                      : []
                  }
                />
              </div>
            </fieldset>
          );
        })}
    </div>
  );
}

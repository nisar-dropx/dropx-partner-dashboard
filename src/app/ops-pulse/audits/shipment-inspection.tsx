"use client";
import { useEffect, useMemo, useState } from "react";
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
  onChange,
}: {
  name: string;
  people: AuditEmployee[];
  multiple?: boolean;
  required?: boolean;
  initial?: AuditEmployee[];
  onChange?: (refs: string[]) => void;
}) {
  const [selected, setSelectedState] = useState(initial.map((p) => p.ref));
  const setSelected = (change: (old: string[]) => string[]) => {
    const next = change(selected);
    setSelectedState(next);
    onChange?.(next);
  };
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
  onDifferences,
  restoredNotes,
}: {
  onDifferences?: (keys: string[]) => void;
  /** Observations recovered from a saved draft; merged over what is on screen. */
  restoredNotes?: Record<string, string> | null;
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
  const [bulkNote, setBulkNote] = useState("");
  const [bulkTarget, setBulkTarget] = useState("empty");
  useEffect(() => {
    if (restoredNotes) setNotes((old) => ({ ...old, ...restoredNotes }));
  }, [restoredNotes]);
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
  useEffect(() => {
    onDifferences?.([...result.missing, ...result.excess]);
  }, [result, onDifferences]);
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
            {rows.length > 1 && (
              <div className={styles.bulkBar}>
                <strong>Fill many at once</strong>
                <input
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                  placeholder="Observation to apply"
                  aria-label="Observation to apply to several shipments"
                />
                <select
                  value={bulkTarget}
                  onChange={(e) => setBulkTarget(e.target.value)}
                  aria-label="Which shipments to fill"
                >
                  <option value="empty">Those without an observation</option>
                  <option value="Missing">All missing</option>
                  <option value="Excess">All excess</option>
                  <option value="all">All {rows.length}</option>
                </select>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!bulkNote.trim()}
                  onClick={() => {
                    const text = bulkNote.trim();
                    setNotes((old) => {
                      const next = { ...old };
                      for (const row of rows) {
                        const wanted =
                          bulkTarget === "all" ||
                          (bulkTarget === "empty"
                            ? !old[row.tid]?.trim()
                            : row.kind === bulkTarget);
                        if (wanted) next[row.tid] = text;
                      }
                      return next;
                    });
                  }}
                >
                  Apply
                </button>
              </div>
            )}
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

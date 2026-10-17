"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  compareAuditTids,
  auditDifferencesWorkbook,
  auditHelpSheet,
  auditTidTemplate,
  parseAuditTids,
  readAuditTidSheet,
  type AuditEmployee,
  type AuditSheet,
} from "@/lib/ops-pulse/station-audit-reconciliation";
import type {
  AuditOption,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import styles from "./audit-workspace.module.css";

/** Searchable staff dropdown with optional multi-select chips for audit forms. */
export function EmployeePicker({
  name,
  people,
  multiple = false,
  required = false,
  initial = [],
  onChange,
  placeholder = "Select staff",
  emptyHint = "No station-linked employee IDs available. Update the People/workforce station mapping.",
  maxOptions = 200,
  maxSelected = 25,
}: {
  name: string;
  people: AuditEmployee[];
  multiple?: boolean;
  required?: boolean;
  initial?: AuditEmployee[];
  onChange?: (refs: string[]) => void;
  placeholder?: string;
  emptyHint?: string;
  maxOptions?: number;
  maxSelected?: number;
}) {
  const [selected, setSelectedState] = useState(initial.map((p) => p.ref));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const limit = multiple ? maxSelected : 1;

  const byRef = useMemo(() => {
    const map = new Map<string, AuditEmployee>();
    for (const person of [...people, ...initial]) map.set(person.ref, person);
    return map;
  }, [people, initial]);

  const setSelected = (next: string[]) => {
    const unique = [...new Set(next)].slice(0, limit);
    setSelectedState(unique);
    onChange?.(unique);
  };

  const toggle = (ref: string) => {
    if (selected.includes(ref)) {
      setSelected(selected.filter((value) => value !== ref));
      return;
    }
    if (!multiple) {
      setSelected([ref]);
      setOpen(false);
      setQuery("");
      return;
    }
    if (selected.length >= limit) return;
    setSelected([...selected, ref]);
  };

  const term = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = people.filter((person) => {
      if (!term) return true;
      return `${person.employee_code} ${person.full_name} ${person.designation}`
        .toLowerCase()
        .includes(term);
    });
    return filtered.slice(0, maxOptions);
  }, [people, term, maxOptions]);

  const allShownSelected =
    shown.length > 0 && shown.every((person) => selected.includes(person.ref));

  const toggleShown = () => {
    if (!multiple) return;
    if (allShownSelected) {
      const drop = new Set(shown.map((person) => person.ref));
      setSelected(selected.filter((ref) => !drop.has(ref)));
      return;
    }
    setSelected([
      ...new Set([...selected, ...shown.map((person) => person.ref)]),
    ]);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const triggerLabel = (() => {
    if (!selected.length) return placeholder;
    if (!multiple) {
      const person = byRef.get(selected[0]);
      return person
        ? `${person.employee_code} · ${person.full_name}`
        : "1 selected";
    }
    if (selected.length === 1) {
      const person = byRef.get(selected[0]);
      return person
        ? `${person.employee_code} · ${person.full_name}`
        : "1 selected";
    }
    return `${selected.length} staff selected`;
  })();

  return (
    <div className={styles.staffPicker} ref={box}>
      {selected.map((ref) => (
        <input key={ref} type="hidden" name={name} value={ref} />
      ))}
      <input
        className={styles.staffRequired}
        tabIndex={-1}
        aria-hidden
        value={selected.length ? "1" : ""}
        required={required}
        onChange={() => undefined}
        onInvalid={(event) =>
          (event.target as HTMLInputElement).setCustomValidity(
            required && !selected.length
              ? "Select at least one staff member from the list."
              : "",
          )
        }
        onInput={(event) =>
          (event.target as HTMLInputElement).setCustomValidity("")
        }
      />
      <div className={styles.staffControl}>
        <button
          type="button"
          className={`${styles.staffTrigger}${open ? ` ${styles.staffTriggerOpen}` : ""}`}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={!people.length}
          onClick={() => {
            if (!people.length) return;
            setOpen((current) => !current);
            if (open) setQuery("");
          }}
        >
          <span
            className={
              selected.length
                ? styles.staffTriggerValue
                : styles.staffTriggerPlaceholder
            }
          >
            {triggerLabel}
          </span>
          <i aria-hidden>{open ? "▴" : "▾"}</i>
        </button>

        {open && people.length > 0 ? (
          <div
            className={styles.staffMenu}
            role="listbox"
            aria-multiselectable={multiple}
          >
            <div className={styles.staffSearch}>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${people.length} staff by ID, name or role`}
                aria-label="Search staff"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpen(false);
                    setQuery("");
                  }
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
            </div>
            {multiple ? (
              <label className={styles.staffSelectAll}>
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={toggleShown}
                  disabled={!shown.length}
                />
                Select all shown{term ? " (filtered)" : ""}
              </label>
            ) : null}
            <div className={styles.staffList}>
              {shown.map((person) => {
                const checked = selected.includes(person.ref);
                return (
                  <label
                    key={person.ref}
                    className={`${styles.staffOption}${checked ? ` ${styles.staffOptionSelected}` : ""}`}
                  >
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`${name}_choice`}
                      checked={checked}
                      onChange={() => toggle(person.ref)}
                    />
                    <span>
                      <b>
                        {person.employee_code} · {person.full_name}
                      </b>
                      <small>
                        {person.designation || "Staff"}
                        {person.is_active ? "" : " · inactive"}
                      </small>
                    </span>
                  </label>
                );
              })}
              {!shown.length ? (
                <p className={styles.staffEmpty}>
                  {term
                    ? `No staff match “${query.trim()}”.`
                    : "No staff available."}
                </p>
              ) : null}
            </div>
            <div className={styles.staffFoot}>
              <span>
                {selected.length}
                {multiple ? ` / ${limit}` : ""} selected
                {term && shown.length < people.length
                  ? ` · showing ${shown.length}`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {selected.length > 0 && (
        <div className={styles.staffChips} aria-label="Selected staff">
          {selected.map((ref) => {
            const person = byRef.get(ref);
            return (
              <span key={ref} className={styles.staffChip}>
                <strong>{person?.employee_code || "Staff"}</strong>
                <span>{person?.full_name || ref}</span>
                {person?.designation ? <em>{person.designation}</em> : null}
                <button
                  type="button"
                  aria-label={`Remove ${person?.full_name || ref}`}
                  onClick={() => toggle(ref)}
                >
                  ×
                </button>
              </span>
            );
          })}
          {multiple && selected.length > 1 ? (
            <button
              type="button"
              className={styles.staffClear}
              onClick={() => setSelected([])}
            >
              Clear all
            </button>
          ) : null}
        </div>
      )}

      {!people.length ? (
        <small className={styles.staffHint}>{emptyHint}</small>
      ) : null}
    </div>
  );
}
/** Opens the file picker for one spreadsheet; the same file can be chosen again. */
function SheetButton({
  label,
  onFile,
}: {
  label: string;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={styles.miniButton}
        onClick={() => input.current?.click()}
      >
        {label}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={label}
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}
type SheetTarget = "expected" | "scanned" | "reasons";
/** Builds an Excel file from plain rows and hands it to the browser to save. */
async function saveWorkbook(sheets: AuditSheet[], fileName: string) {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  for (const { name, rows, widths } of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  XLSX.writeFile(book, fileName);
}
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
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
  // Which differences are listed: any mix of kinds, optionally only those still
  // waiting for an observation, optionally matching a typed tracking ID.
  const [kinds, setKinds] = useState<string[]>(["Missing", "Excess"]);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
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
  const PAGE = 25;
  const term = search.trim().toUpperCase();
  const view = rows.filter(
    (row) =>
      kinds.includes(row.kind) &&
      (!pendingOnly || !notes[row.tid]?.trim()) &&
      (!term || row.tid.toUpperCase().includes(term)),
  );
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = view.slice(current * PAGE, current * PAGE + PAGE);
  const viewIds = new Set(view.map((row) => row.tid));
  // A selection only counts while its shipments are still listed.
  const selected = picked.filter((tid) => viewIds.has(tid));
  const targets = selected.length ? selected : view.map((row) => row.tid);
  const pageSelected =
    shown.length > 0 && shown.every((row) => selected.includes(row.tid));
  const toggleKind = (kind: string) => {
    setKinds((old) =>
      old.includes(kind) ? old.filter((k) => k !== kind) : [...old, kind],
    );
    setPage(0);
  };
  const [sheetNotice, setSheetNotice] = useState<
    Partial<Record<SheetTarget, string>>
  >({});
  // Reads a spreadsheet in the browser. Tracking IDs join the chosen list and any
  // reason typed beside one becomes that shipment's observation.
  const importSheet = async (target: SheetTarget, file: File) => {
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Choose a file up to 10 MB.");
      const XLSX = await import("xlsx");
      // Text files keep their cells as typed, so long numeric IDs stay exact.
      const book = XLSX.read(await file.arrayBuffer(), {
        type: "array",
        raw: true,
      });
      // The first data sheet that holds tracking IDs is used; the template's
      // guide and sample sheets are never read.
      const sheets = book.SheetNames.filter(
        (name) => !auditHelpSheet.test(name.trim()) && book.Sheets[name]?.["!ref"],
      );
      if (!sheets.length)
        throw new Error(
          "This file has no rows to read. Enter the tracking IDs in the first sheet.",
        );
      let read: ReturnType<typeof readAuditTidSheet> | null = null;
      let problem: unknown = null;
      for (const name of sheets) {
        try {
          read = readAuditTidSheet(
            XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], {
              header: 1,
              raw: true,
              defval: "",
            }),
          );
          break;
        } catch (e) {
          problem ??= e;
        }
      }
      if (!read) throw problem;
      const reasonCount = Object.keys(read.reasons).length;
      if (target === "reasons") {
        if (!read.hasReasons)
          throw new Error(
            "Add a Reason column beside the tracking IDs, then upload again.",
          );
        const open = new Set(rows.map((row) => row.tid));
        const matched = Object.entries(read.reasons).filter(([tid]) =>
          open.has(tid),
        );
        if (!matched.length)
          throw new Error(
            "None of the reasons in this file belong to a missing or excess shipment listed here.",
          );
        setNotes((old) => ({ ...old, ...Object.fromEntries(matched) }));
        setSheetNotice((old) => ({
          ...old,
          reasons: [
            `${file.name}: ${plural(matched.length, "reason")} filled`,
            reasonCount > matched.length
              ? `${reasonCount - matched.length} not in the differences`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        }));
        return;
      }
      let listed: string[] = [];
      try {
        listed = parseAuditTids(target === "expected" ? expected : scanned).ids;
      } catch {
        throw new Error(
          "Correct the tracking IDs already in this list before adding a file.",
        );
      }
      const have = new Set(listed);
      const fresh = read.ids.filter((tid) => !have.has(tid));
      if (listed.length + fresh.length > 10000)
        throw new Error("Maximum 10,000 unique TIDs per list.");
      (target === "expected" ? setExpected : setScanned)(
        [...listed, ...fresh].join("\n"),
      );
      if (reasonCount) setNotes((old) => ({ ...old, ...read.reasons }));
      setPage(0);
      setSheetNotice((old) => ({
        ...old,
        [target]: [
          `${file.name}: ${plural(fresh.length, "tracking ID")} added`,
          read.ids.length > fresh.length
            ? `${read.ids.length - fresh.length} already in the list`
            : "",
          read.duplicates ? `${plural(read.duplicates, "repeat")} ignored` : "",
          read.skipped
            ? `${plural(read.skipped, "row")} skipped (not a tracking ID)`
            : "",
          reasonCount ? `${plural(reasonCount, "reason")} read` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
    } catch (e) {
      setSheetNotice((old) => ({
        ...old,
        [target]: `${file.name}: ${e instanceof Error ? e.message : "this file could not be read."}`,
      }));
    }
  };
  // The same two columns work for the ERP ageing list, the physical scan and reasons.
  const downloadTemplate = async () => {
    try {
      await saveWorkbook(auditTidTemplate(), "audit-tracking-id-template.xlsx");
    } catch {
      setSheetNotice((old) => ({
        ...old,
        expected: "The template could not be downloaded. Try again.",
      }));
    }
  };
  const downloadDifferences = async () => {
    try {
      await saveWorkbook(
        auditDifferencesWorkbook(
          rows.map((row) => ({
            tid: row.tid,
            kind: row.kind,
            reason: notes[row.tid] || "",
          })),
        ),
        "audit-differences.xlsx",
      );
    } catch {
      setSheetNotice((old) => ({
        ...old,
        reasons: "The differences could not be downloaded. Try again.",
      }));
    }
  };
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
          Paste tracking IDs or upload an Excel or CSV file for either list.
          Scan every physical shipment; duplicate TIDs count once. Counts and
          differences are calculated automatically. A Reason column in the
          file fills the observation for that shipment.{" "}
          <button
            type="button"
            className={styles.textButton}
            style={{ padding: 0 }}
            onClick={() => void downloadTemplate()}
          >
            Download the Excel template
          </button>{" "}
          It includes a column guide and a filled sample.
        </p>
        <div className={styles.reconciliationGrid}>
          <div>
            <h3>1. ERP ageing · {result.a.ids.length}</h3>
            <div className={styles.sheetTools}>
              <SheetButton
                label="Upload Excel / CSV"
                onFile={(file) => void importSheet("expected", file)}
              />
              <small role="status">{sheetNotice.expected}</small>
            </div>
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
            <div className={styles.sheetTools}>
              <SheetButton
                label="Upload Excel / CSV"
                onFile={(file) => void importSheet("scanned", file)}
              />
              <small role="status">{sheetNotice.scanned}</small>
            </div>
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
            {rows.length > 0 && (
              <div className={styles.sheetTools}>
                <button
                  type="button"
                  className={styles.miniButton}
                  onClick={() => void downloadDifferences()}
                >
                  Download as Excel
                </button>
                <SheetButton
                  label="Upload reasons"
                  onFile={(file) => void importSheet("reasons", file)}
                />
                <small role="status">
                  {sheetNotice.reasons ||
                    "Fill the Reason column in the downloaded file, then upload it."}
                </small>
              </div>
            )}
            {rows.length > 0 && (
              <div className={styles.responseFilters}>
                <span>Show</span>
                {["Missing", "Excess"].map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind)}
                      onChange={() => toggleKind(kind)}
                    />{" "}
                    {kind} (
                    {kind === "Missing"
                      ? result.missing.length
                      : result.excess.length}
                    )
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={pendingOnly}
                    onChange={(e) => {
                      setPendingOnly(e.target.checked);
                      setPage(0);
                    }}
                  />{" "}
                  Only without an observation
                </label>
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  placeholder="Find a tracking ID"
                  aria-label="Find a tracking ID in the differences"
                />
              </div>
            )}
            {rows.length > 1 && (
              <div className={styles.bulkBar}>
                <strong>
                  Fill many at once ·{" "}
                  {selected.length
                    ? `${selected.length} selected`
                    : `all ${view.length} listed`}
                </strong>
                <input
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  placeholder="Observation to apply"
                  aria-label="Observation to apply to several shipments"
                />
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!bulkNote.trim() || !targets.length}
                  onClick={() => {
                    const text = bulkNote.trim();
                    setNotes((old) => {
                      const next = { ...old };
                      for (const tid of targets) next[tid] = text;
                      return next;
                    });
                    setPicked([]);
                  }}
                >
                  Apply to {targets.length}
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!shown.length}
                  onClick={() =>
                    setPicked(
                      pageSelected
                        ? selected.filter(
                            (tid) => !shown.some((row) => row.tid === tid),
                          )
                        : [
                            ...new Set([
                              ...selected,
                              ...shown.map((row) => row.tid),
                            ]),
                          ],
                    )
                  }
                >
                  {pageSelected ? "Unselect this page" : "Select this page"}
                </button>
                {selected.length > 0 && (
                  <button
                    type="button"
                    className="button secondary compact"
                    onClick={() => setPicked([])}
                  >
                    Clear selection
                  </button>
                )}
              </div>
            )}
            <div className={styles.tidDifferences}>
              {shown.map((row) => (
                <div key={row.tid} className={styles.tidRow}>
                  <strong>
                    <input
                      type="checkbox"
                      checked={selected.includes(row.tid)}
                      onChange={(e) =>
                        setPicked((old) =>
                          e.target.checked
                            ? [...old.filter((tid) => tid !== row.tid), row.tid]
                            : old.filter((tid) => tid !== row.tid),
                        )
                      }
                      aria-label={`Select ${row.tid}`}
                    />{" "}
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
                </div>
              ))}
              {!rows.length && !result.error && (
                <p>No missing or excess TIDs in these lists.</p>
              )}
              {rows.length > 0 && !view.length && (
                <p>No differences match this view.</p>
              )}
            </div>
            {pages > 1 && (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={!current}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </button>
                <span>
                  {current + 1} / {pages}
                </span>
                <button
                  type="button"
                  disabled={current + 1 >= pages}
                  onClick={() => setPage(current + 1)}
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
        {/* Only the observations for listed differences are sent, so reasons read
            from a large file never push the report past the upload limit. */}
        <input
          type="hidden"
          name="tid_remarks"
          value={JSON.stringify(
            result.error
              ? notes
              : Object.fromEntries(
                  rows
                    .filter((row) => notes[row.tid])
                    .map((row) => [row.tid, notes[row.tid]]),
                ),
          )}
        />
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

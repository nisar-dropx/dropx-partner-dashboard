"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "@/components/ops-loss-report.module.css";

/** Keep wide Amazon files readable: identity columns first, at most 12 columns on screen (CSV has all). */
const MAX_COLUMNS = 12;
const LONG_TEXT = /remark|comment|note|description|reason/i;

const amount = (value: string | undefined) => {
  const n = Number(String(value ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && String(value ?? "").trim() ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n) : value ?? "";
};

export function OpsLossCases({ station, stationName, rows, headers, referenceColumn, stationColumn, amountColumn, closeHref, fileLabel }: {
  station: string;
  stationName: string | null;
  rows: Record<string, string>[];
  headers: string[];
  referenceColumn: string | null;
  stationColumn: string | null;
  amountColumn: string | null;
  closeHref: string;
  fileLabel: string;
}) {
  const [query, setQuery] = useState("");
  const columns = useMemo(() => [
    ...[referenceColumn, amountColumn].filter((c): c is string => Boolean(c)),
    ...headers.filter((h) => h !== referenceColumn && h !== amountColumn && h !== stationColumn && h.toLowerCase() !== "id")
  ].slice(0, MAX_COLUMNS), [headers, referenceColumn, amountColumn, stationColumn]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
  }, [rows, query]);

  function exportCsv() {
    const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [headers.map(esc).join(","), ...shown.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `losses-${fileLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return <section className={styles.panel} aria-label={`${station} cases`}>
    <div className={styles.panelHead}>
      <div><h2>{station}{stationName ? ` · ${stationName}` : ""}</h2><p>{rows.length.toLocaleString("en-IN")} {rows.length === 1 ? "case" : "cases"}{query ? ` · ${shown.length} match` : ""}</p></div>
      <div className={styles.toolbar}>
        <label className={styles.search}><span aria-hidden>⌕</span><input type="search" placeholder="Search cases" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search cases" /></label>
        <button type="button" className={styles.button} onClick={exportCsv}>Download CSV</button>
        <Link href={closeHref} scroll={false} className={styles.button}>Close</Link>
      </div>
    </div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr>{columns.map((c) => <th key={c} className={c === amountColumn ? styles.numeric : undefined}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
      <tbody>
        {shown.map((r, i) => <tr key={i}>{columns.map((c) =>
          <td key={c} className={c === amountColumn ? styles.numeric : LONG_TEXT.test(c) ? styles.remark : undefined}>{c === amountColumn ? <strong>{amount(r[c])}</strong> : r[c] ?? ""}</td>)}</tr>)}
        {!shown.length ? <tr><td colSpan={Math.max(columns.length, 1)}><div className={styles.empty}>No cases match “{query}”.</div></td></tr> : null}
      </tbody>
    </table></div>
  </section>;
}

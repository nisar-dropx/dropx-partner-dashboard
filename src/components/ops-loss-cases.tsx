"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "@/components/ops-loss-report.module.css";
import type { LossRow } from "@/lib/ops-pulse/loss-reports";

type Column = { key: keyof LossRow; label: string; kind?: "money" | "date" | "long" | "tid" };

/** Per-report labels for the typed loss_cases columns. Empty columns are hidden. */
const COLUMNS: Record<"nl" | "slp", Column[]> = {
  nl: [
    { key: "tid", label: "TID", kind: "tid" }, { key: "amount", label: "Value", kind: "money" },
    { key: "case_status", label: "Status" }, { key: "category", label: "Loss bucket" }, { key: "sub_category", label: "Sub bucket" },
    { key: "impact_date", label: "Impact date", kind: "date" }, { key: "da_name", label: "DA" }, { key: "period", label: "Recovery month" },
    { key: "remarks", label: "Remarks", kind: "long" }
  ],
  slp: [
    { key: "tid", label: "TID", kind: "tid" }, { key: "amount", label: "Recovery", kind: "money" },
    { key: "case_status", label: "Status" }, { key: "category", label: "Case source" }, { key: "sub_category", label: "TID alignment" },
    { key: "impact_date", label: "Created", kind: "date" }, { key: "closed_date", label: "Closed", kind: "date" }, { key: "period", label: "Period" },
    { key: "remarks", label: "Remarks", kind: "long" }
  ]
};

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const dateFmt = (v: string) => new Date(`${v}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function cellText(row: LossRow, col: Column): string {
  const v = row[col.key];
  if (v == null || v === "") return "";
  if (col.kind === "money") return money.format(Number(v));
  if (col.kind === "date") return dateFmt(String(v));
  return String(v);
}

export function OpsLossCases({ report, station, stationName, rows, closeHref, fileLabel, showPeriod = false }: {
  report: "nl" | "slp";
  station: string;
  stationName: string | null;
  rows: LossRow[];
  closeHref: string;
  fileLabel: string;
  showPeriod?: boolean;
}) {
  const [query, setQuery] = useState("");
  const columns = useMemo(() => COLUMNS[report].filter((c) => (c.key !== "period" || showPeriod || report === "nl") && rows.some((r) => r[c.key] != null && r[c.key] !== "")), [report, rows, showPeriod]);
  const approxCount = useMemo(() => rows.filter((r) => r.tid_approximate).length, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [...COLUMNS[report].map((c) => r[c.key]), ...Object.values(r.extra ?? {})].some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, query, report]);

  function exportCsv() {
    const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.extra ?? {})))];
    const base = COLUMNS[report];
    const head = ["Station", ...base.map((c) => c.label), "TID approximate", ...extraKeys];
    const lines = shown.map((r) => [station, ...base.map((c) => r[c.key]), r.tid_approximate ? "yes" : "", ...extraKeys.map((k) => r.extra?.[k])].map(esc).join(","));
    const url = URL.createObjectURL(new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `losses-${fileLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return <section className={styles.panel} aria-label={`${station} cases`}>
    <div className={styles.panelHead}>
      <div>
        <h2>{station}{stationName ? ` · ${stationName}` : ""}</h2>
        <p>{rows.length.toLocaleString("en-IN")} {rows.length === 1 ? "case" : "cases"}{query ? ` · ${shown.length} match` : ""}
          {approxCount ? ` · ≈ ${approxCount} TID${approxCount === 1 ? "" : "s"} rounded in Amazon's file` : ""}</p>
      </div>
      <div className={styles.toolbar}>
        <label className={styles.search}><span aria-hidden>⌕</span><input type="search" placeholder="Search TID, status, DA, remarks" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search cases" /></label>
        <button type="button" className={styles.button} onClick={exportCsv}>Download CSV</button>
        <Link href={closeHref} scroll={false} className={styles.button}>Close</Link>
      </div>
    </div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr>{columns.map((c) => <th key={c.key} className={c.kind === "money" ? styles.numeric : undefined}>{c.label}</th>)}</tr></thead>
      <tbody>
        {shown.map((r) => <tr key={r.case_key}>{columns.map((c) => {
          const text = cellText(r, c);
          if (c.kind === "money") return <td key={c.key} className={styles.numeric}><strong>{text}</strong></td>;
          if (c.kind === "long") return <td key={c.key} className={styles.remark}>{text}</td>;
          if (c.kind === "tid") return <td key={c.key} className={styles.mono} title={r.tid_approximate ? "Amazon's file only kept the first digits of this TID" : undefined}>{r.tid_approximate ? `≈ ${text}` : text}</td>;
          return <td key={c.key} className={c.kind === "date" ? styles.nowrap : undefined}>{text}</td>;
        })}</tr>)}
        {!shown.length ? <tr><td colSpan={Math.max(columns.length, 1)}><div className={styles.empty}>No cases match “{query}”.</div></td></tr> : null}
      </tbody>
    </table></div>
  </section>;
}

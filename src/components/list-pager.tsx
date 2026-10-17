"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "./list-pager.module.css";

import { PAGE_SIZES, pageWindow } from "@/lib/page-window";
export { PAGE_SIZES, pageWindow };

/** Client-side paging for a list already in the browser; resets to page 1 when the list changes. */
export function usePaged<T>(items: T[], initialSize = 25, resetKey = "") {
  const [size, setSize] = useState(initialSize);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey, size]);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages);
  const rows = useMemo(() => items.slice((current - 1) * size, current * size), [items, current, size]);
  return { rows, page: current, pages, size, total: items.length, setPage, setSize };
}

export function ListPager({ page, pages, size, total, onPage, onSize, label = "rows" }: {
  page: number; pages: number; size: number; total: number; onPage: (n: number) => void; onSize: (n: number) => void; label?: string;
}) {
  if (!total) return null;
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  return (
    <nav className={styles.pager} aria-label="Pages">
      <span className={styles.count}>{from}–{to} of {total.toLocaleString("en-IN")} {label}</span>
      <label className={styles.size}>Rows per page
        <select value={size} onChange={(e) => onSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </label>
      {pages > 1 ? (
        <span className={styles.pages}>
          <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
          {pageWindow(page, pages).map((n, i) => n === "…" ? <span key={`g${i}`} className={styles.gap}>…</span> : (
            <button key={n} onClick={() => onPage(n)} aria-current={n === page ? "page" : undefined} className={n === page ? styles.on : undefined}>{n}</button>
          ))}
          <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">›</button>
        </span>
      ) : null}
    </nav>
  );
}

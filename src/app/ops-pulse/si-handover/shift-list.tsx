"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { statusLabels, type WorkspaceView } from "@/lib/ops-pulse/si-handover/model";
import {
  filterProgressRows,
  paginateRows,
  sortProgressRows,
  type ProgressRow,
  type SortKey,
} from "@/lib/ops-pulse/si-handover/report";
import styles from "./si-handover.module.css";

type Props = {
  title: string;
  rows: ProgressRow[];
  view: WorkspaceView;
  highlightMine?: boolean;
  empty?: string;
  pageSize?: number;
};

export function ShiftList(props: Props) {
  const [store, setStore] = useState("");
  const [si, setSi] = useState("");
  const [status, setStatus] = useState("");
  const [slot, setSlot] = useState("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const stores = useMemo(
    () =>
      [...new Map(props.rows.map((r) => [r.location_id, r.store_code])).entries()]
        .map(([id, code]) => ({ id, code }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [props.rows],
  );
  const sis = useMemo(
    () =>
      [...new Map(props.rows.map((r) => [r.outgoing_user_id, r.outgoing_name])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [props.rows],
  );
  const slots = useMemo(
    () => [...new Set(props.rows.map((r) => r.shift_slot))].sort(),
    [props.rows],
  );

  const filtered = useMemo(
    () =>
      sortProgressRows(
        filterProgressRows(props.rows, { store, si, status, slot, q }),
        sort,
      ),
    [props.rows, store, si, status, slot, q, sort],
  );

  useEffect(() => {
    setPage(1);
  }, [store, si, status, slot, q, sort]);

  const pageSize = props.pageSize || 12;
  const paged = paginateRows(filtered, page, pageSize);

  return (
    <div className={styles.shiftList}>
      <div className={styles.shiftListHead}>
        <h2 className={styles.sectionTitle}>{props.title}</h2>
        <span className={styles.chip}>
          {filtered.length} shift{filtered.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className={styles.filterBar}>
        <label className={styles.field}>
          Store
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">All</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Shift Incharge
          <select value={si} onChange={(e) => setSi(e.target.value)}>
            <option value="">All</option>
            {sis.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {(
              ["open", "submitted", "rejected", "accepted", "cancelled"] as const
            ).map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Slot
          <select value={slot} onChange={(e) => setSlot(e.target.value)}>
            <option value="">All</option>
            {slots.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="date_desc">Date · newest</option>
            <option value="date_asc">Date · oldest</option>
            <option value="pct_desc">Completion · high</option>
            <option value="pct_asc">Completion · low</option>
            <option value="store">Store</option>
            <option value="si">Shift Incharge</option>
            <option value="status">Status</option>
          </select>
        </label>
        <label className={styles.field}>
          Search
          <input
            value={q}
            placeholder="Store, SI, date…"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>

      {!paged.rows.length ? (
        <div className={styles.empty}>{props.empty || "No shifts match."}</div>
      ) : (
        <div className={styles.list}>
          {paged.rows.map((r) => (
            <Link
              key={r.id}
              prefetch={false}
              className={`${styles.card}${props.highlightMine ? ` ${styles.cardMine}` : ""}`}
              href={`/si-handover?view=${props.view}&id=${r.id}`}
            >
              <div className={styles.cardTop}>
                <strong>
                  {r.store_code} · {r.shift_date} {r.shift_slot}
                </strong>
                <span
                  className={
                    r.pct >= 80
                      ? styles.pctOk
                      : r.pct >= 40
                        ? styles.pctMid
                        : styles.pctLow
                  }
                >
                  {r.pct}%
                </span>
              </div>
              <small>
                {statusLabels[r.status]} · {r.outgoing_name}
                {r.total ? ` · ${r.answered}/${r.total} tasks` : ""}
                {r.escalate !== "none" ? ` · escalate ${r.escalate}` : ""}
              </small>
              <div className={styles.cardProgress}>
                <div
                  className={styles.cardProgressFill}
                  style={{ width: `${r.pct}%` }}
                />
              </div>
            </Link>
          ))}
        </div>
      )}

      {paged.pages > 1 ? (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.lineAdd}
            disabled={paged.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {paged.page} / {paged.pages}
          </span>
          <button
            type="button"
            className={styles.lineAdd}
            disabled={paged.page >= paged.pages}
            onClick={() => setPage((p) => Math.min(paged.pages, p + 1))}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

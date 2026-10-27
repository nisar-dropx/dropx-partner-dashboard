"use client";

import { OpsScreenLink as Link } from "@/components/ops-screen-runtime";
import { useEffect, useMemo, useState } from "react";
import {
  statusLabels,
  type ChecklistStatus,
  type WorkspaceView,
} from "@/lib/ops-pulse/si-handover/model";
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

function statusClass(status: ChecklistStatus) {
  switch (status) {
    case "open":
      return styles.statusOpen;
    case "submitted":
      return styles.statusSubmitted;
    case "accepted":
      return styles.statusAccepted;
    case "rejected":
      return styles.statusRejected;
    case "cancelled":
      return styles.statusCancelled;
    default:
      return "";
  }
}

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
          {filtered.length} of {props.rows.length}
        </span>
      </div>
      <div className={styles.filterBar}>
        <label className={styles.field}>
          Store
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Person
          <select value={si} onChange={(e) => setSi(e.target.value)}>
            <option value="">Everyone</option>
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
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="pct_desc">Completion · high</option>
            <option value="pct_asc">Completion · low</option>
            <option value="store">Store</option>
            <option value="si">Person</option>
            <option value="status">Status</option>
          </select>
        </label>
        <label className={styles.field}>
          Search
          <input
            value={q}
            placeholder="Store or name…"
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
                  {r.store_code}
                  <span className={styles.cardWhen}>
                    {" "}
                    · {r.shift_date} {r.shift_slot}
                  </span>
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
              <div className={styles.cardMeta}>
                <span className={`${styles.statusPill} ${statusClass(r.status)}`}>
                  {statusLabels[r.status]}
                </span>
                <small>{r.outgoing_name}</small>
                {r.total ? (
                  <small>
                    {r.answered}/{r.total} tasks
                  </small>
                ) : null}
                {r.escalate !== "none" ? (
                  <span className={`${styles.statusPill} ${styles.statusSubmitted}`}>
                    escalate {r.escalate}
                  </span>
                ) : null}
              </div>
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

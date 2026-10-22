"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { statusLabels } from "@/lib/ops-pulse/si-handover/model";
import {
  filterProgressRows,
  paginateRows,
  sortProgressRows,
  type ProgressRow,
  type ReportSummary,
  type SortKey,
} from "@/lib/ops-pulse/si-handover/report";
import styles from "../si-handover.module.css";

type Store = { id: string; station_code: string; station_name: string | null };

type Props = {
  from: string;
  to: string;
  summary: ReportSummary;
  rows: ProgressRow[];
  stores: Store[];
};

export function SiHandoverReportClient(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(props.from);
  const [to, setTo] = useState(props.to);
  const [store, setStore] = useState("");
  const [si, setSi] = useState("");
  const [status, setStatus] = useState("");
  const [slot, setSlot] = useState("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setFrom(props.from);
    setTo(props.to);
    setPage(1);
  }, [props.from, props.to, props.rows]);

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
  const paged = paginateRows(filtered, page, 20);

  const applyRange = () => {
    start(() => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      router.push(`/si-handover/report?${params.toString()}`);
    });
  };

  const s = props.summary;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
        <h1>Manager report</h1>
        <p>
          Analysed view of Shift Incharge activities across your stores — completion,
          handover flow, and who needs follow-up.{" "}
          <Link href="/si-handover?view=start">Back to workspace</Link>
        </p>
      </header>

      <section className={styles.panel}>
        <div className={styles.filterBar}>
          <label className={styles.field}>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className={styles.field}>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className={styles.btnAccent}
            disabled={pending}
            onClick={applyRange}
          >
            Apply dates
          </button>
        </div>

        <div className={styles.kpiGrid}>
          <div className={styles.kpi}>
            <strong>{s.shifts}</strong>
            <span>Shifts</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.avgPct}%</strong>
            <span>Avg completion</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.submitRate}%</strong>
            <span>Submitted</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.acceptRate}%</strong>
            <span>Accepted of submitted</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.open}</strong>
            <span>Still open</span>
          </div>
          <div className={styles.kpiWarn}>
            <strong>{s.overdueAccept}</strong>
            <span>Overdue accept</span>
          </div>
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>By Shift Incharge</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Shift Incharge</th>
                <th>Shifts</th>
                <th>Avg %</th>
                <th>Open</th>
                <th>Submitted</th>
                <th>Accepted</th>
                <th>Rejected</th>
                <th>Overdue</th>
              </tr>
            </thead>
            <tbody>
              {!s.bySi.length ? (
                <tr>
                  <td colSpan={8}>No shifts in this range.</td>
                </tr>
              ) : (
                s.bySi.map((b) => (
                  <tr key={b.key}>
                    <td>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => {
                          setSi(b.key);
                          setPage(1);
                        }}
                      >
                        {b.label}
                      </button>
                    </td>
                    <td>{b.shifts}</td>
                    <td>{b.avgPct}%</td>
                    <td>{b.open}</td>
                    <td>{b.submitted}</td>
                    <td>{b.accepted}</td>
                    <td>{b.rejected}</td>
                    <td>{b.overdue}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>By store</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Store</th>
                <th>Shifts</th>
                <th>Avg %</th>
                <th>Open</th>
                <th>Submitted</th>
                <th>Accepted</th>
                <th>Overdue</th>
              </tr>
            </thead>
            <tbody>
              {!s.byStore.length ? (
                <tr>
                  <td colSpan={7}>No shifts in this range.</td>
                </tr>
              ) : (
                s.byStore.map((b) => (
                  <tr key={b.key}>
                    <td>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => {
                          setStore(b.key);
                          setPage(1);
                        }}
                      >
                        {b.label}
                      </button>
                    </td>
                    <td>{b.shifts}</td>
                    <td>{b.avgPct}%</td>
                    <td>{b.open}</td>
                    <td>{b.submitted}</td>
                    <td>{b.accepted}</td>
                    <td>{b.overdue}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.shiftListHead}>
          <h2 className={styles.sectionTitle}>Shift detail</h2>
          <span className={styles.chip}>
            {filtered.length} shown · slots{" "}
            {s.bySlot.map((b) => `${b.label}:${b.shifts}`).join(" · ") || "—"}
          </span>
        </div>
        <div className={styles.filterBar}>
          <label className={styles.field}>
            Store
            <select
              value={store}
              onChange={(e) => {
                setStore(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {props.stores.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.station_code}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Shift Incharge
            <select
              value={si}
              onChange={(e) => {
                setSi(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {sis.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {(
                ["open", "submitted", "rejected", "accepted", "cancelled"] as const
              ).map((st) => (
                <option key={st} value={st}>
                  {statusLabels[st]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Slot
            <select
              value={slot}
              onChange={(e) => {
                setSlot(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {slots.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Sort
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as SortKey);
                setPage(1);
              }}
            >
              <option value="date_desc">Date · newest</option>
              <option value="date_asc">Date · oldest</option>
              <option value="pct_desc">Completion · high</option>
              <option value="pct_asc">Completion · low</option>
              <option value="si">Shift Incharge</option>
              <option value="store">Store</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label className={styles.field}>
            Search
            <input
              value={q}
              placeholder="Store, SI…"
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Shift</th>
                <th>SI</th>
                <th>Status</th>
                <th>Completion</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!paged.rows.length ? (
                <tr>
                  <td colSpan={5}>No shifts match filters.</td>
                </tr>
              ) : (
                paged.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.store_code} · {r.shift_date} {r.shift_slot}
                    </td>
                    <td>{r.outgoing_name}</td>
                    <td>
                      {statusLabels[r.status]}
                      {r.escalate !== "none" ? ` · escalate ${r.escalate}` : ""}
                    </td>
                    <td>
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
                      </span>{" "}
                      <small>
                        ({r.answered}/{r.total})
                      </small>
                    </td>
                    <td>
                      <Link
                        prefetch={false}
                        href={`/si-handover?view=during&id=${r.id}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
      </section>
    </div>
  );
}

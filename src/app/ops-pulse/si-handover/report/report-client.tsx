"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { statusLabels as siStatusLabels } from "@/lib/ops-pulse/si-handover/model";
import {
  filterProgressRows as filterSi,
  paginateRows,
  sortProgressRows as sortSi,
  type ProgressRow as SiRow,
  type ReportSummary as SiSummary,
  type SortKey as SiSortKey,
} from "@/lib/ops-pulse/si-handover/report";
import { statusLabels as storeStatusLabels } from "@/lib/ops-pulse/store-ops/model";
import {
  filterProgressRows as filterStore,
  sortProgressRows as sortStore,
  type ProgressRow as StoreRow,
  type ReportSummary as StoreSummary,
  type SortKey as StoreSortKey,
} from "@/lib/ops-pulse/store-ops/report";
import { formatOpsDate } from "@/lib/ops-pulse/date-format";
import { ActivitiesHub } from "../activities-hub";
import styles from "../si-handover.module.css";

type Store = { id: string; station_code: string; station_name: string | null };

type Props = {
  tab: "shift" | "store";
  from: string;
  to: string;
  showShift: boolean;
  showStore: boolean;
  shift?: { summary: SiSummary; rows: SiRow[]; stores: Store[] };
  store?: { summary: StoreSummary; rows: StoreRow[]; stores: Store[] };
};

function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function addDaysIst(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T12:00:00+05:30`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function formatIstRange(from: string, to: string) {
  const fmt = (iso: string) => formatOpsDate(iso, iso);
  if (!from && !to) return "All dates";
  if (from === to) return fmt(from);
  return `${fmt(from)} → ${fmt(to)}`;
}

const RANGE_PRESETS = [
  { id: "7d", label: "Last 7 days", days: 6 },
  { id: "14d", label: "Last 14 days", days: 13 },
  { id: "30d", label: "Last 30 days", days: 29 },
  { id: "today", label: "Today", days: 0 },
] as const;

export function ActivitiesReportClient(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(props.from);
  const [to, setTo] = useState(props.to);
  const [store, setStore] = useState("");
  const [person, setPerson] = useState("");
  const [status, setStatus] = useState("");
  const [slot, setSlot] = useState("");
  const [sort, setSort] = useState<string>("date_desc");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setFrom(props.from);
    setTo(props.to);
    setPage(1);
    setStore("");
    setPerson("");
    setStatus("");
    setSlot("");
    setQ("");
  }, [props.from, props.to, props.tab]);

  const pushRange = (nextFrom: string, nextTo: string) => {
    start(() => {
      const params = new URLSearchParams();
      params.set("tab", props.tab);
      if (nextFrom) params.set("from", nextFrom);
      if (nextTo) params.set("to", nextTo);
      router.push(`/si-handover/report?${params.toString()}`);
    });
  };

  const applyRange = () => {
    const startDate = from || to;
    const endDate = to || from;
    if (startDate && endDate && startDate > endDate) {
      setFrom(endDate);
      setTo(startDate);
      pushRange(endDate, startDate);
      return;
    }
    pushRange(from, to);
  };

  const applyPreset = (daysBack: number) => {
    const end = istToday();
    const start = addDaysIst(end, -daysBack);
    setFrom(start);
    setTo(end);
    pushRange(start, end);
  };

  const activePreset = RANGE_PRESETS.find((p) => {
    const end = istToday();
    const start = addDaysIst(end, -p.days);
    return from === start && to === end;
  });

  const isShift = props.tab === "shift";
  return (
    <div className={styles.pageWide}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
        <h1>{isShift ? "Shift operations report" : "Store operations report"}</h1>
        <p>
          {isShift
            ? "See who is on track, who still needs to submit, and where shift handovers are stuck."
            : "See who is on track, who still needs to submit, and where store day closes are stuck."}
        </p>
      </header>

      <ActivitiesHub
        active={isShift ? "shift-report" : "store-report"}
        showShift={props.showShift}
        showStore={props.showStore}
        showShiftReport={props.showShift}
        showStoreReport={props.showStore}
      />

      <section className={styles.panel}>
        <div className={styles.reportToolbar}>
          <div className={styles.dateRange}>
            <div className={styles.dateRangeHead}>
              <strong>Date range</strong>
              <span className={styles.dateRangeLabel}>
                {formatIstRange(from, to)} · IST
              </span>
            </div>
            <div className={styles.datePresets} role="group" aria-label="Quick ranges">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={
                    activePreset?.id === p.id
                      ? styles.datePresetOn
                      : styles.datePreset
                  }
                  disabled={pending}
                  onClick={() => applyPreset(p.days)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className={styles.filterBar}>
              <label className={styles.field}>
                From
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                To
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={styles.btnAccent}
                disabled={pending || (!from && !to)}
                onClick={applyRange}
              >
                {pending ? "Loading…" : "Apply"}
              </button>
            </div>
          </div>
          <span className={styles.chipOk}>
            {props.tab === "shift" ? "Shift handovers" : "Store day checklists"}
          </span>
        </div>
      </section>

      {props.tab === "shift" && props.shift ? (
        <ShiftReportBody
          summary={props.shift.summary}
          rows={props.shift.rows}
          stores={props.shift.stores}
          store={store}
          setStore={setStore}
          person={person}
          setPerson={setPerson}
          status={status}
          setStatus={setStatus}
          slot={slot}
          setSlot={setSlot}
          sort={sort}
          setSort={setSort}
          q={q}
          setQ={setQ}
          page={page}
          setPage={setPage}
        />
      ) : null}

      {props.tab === "store" && props.store ? (
        <StoreReportBody
          summary={props.store.summary}
          rows={props.store.rows}
          stores={props.store.stores}
          store={store}
          setStore={setStore}
          person={person}
          setPerson={setPerson}
          status={status}
          setStatus={setStatus}
          sort={sort}
          setSort={setSort}
          q={q}
          setQ={setQ}
          page={page}
          setPage={setPage}
        />
      ) : null}
    </div>
  );
}

function ShiftReportBody({
  summary: s,
  rows,
  stores,
  store,
  setStore,
  person,
  setPerson,
  status,
  setStatus,
  slot,
  setSlot,
  sort,
  setSort,
  q,
  setQ,
  page,
  setPage,
}: {
  summary: SiSummary;
  rows: SiRow[];
  stores: Store[];
  store: string;
  setStore: (v: string) => void;
  person: string;
  setPerson: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  slot: string;
  setSlot: (v: string) => void;
  sort: string;
  setSort: (v: string) => void;
  q: string;
  setQ: (v: string) => void;
  page: number;
  setPage: (v: number | ((p: number) => number)) => void;
}) {
  const sis = useMemo(
    () =>
      [...new Map(rows.map((r) => [r.outgoing_user_id, r.outgoing_name])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );
  const slots = useMemo(
    () => [...new Set(rows.map((r) => r.shift_slot))].sort(),
    [rows],
  );
  const filtered = useMemo(
    () =>
      sortSi(
        filterSi(rows, { store, si: person, status, slot, q }),
        sort as SiSortKey,
      ),
    [rows, store, person, status, slot, q, sort],
  );
  const paged = paginateRows(filtered, page, 20);

  return (
    <>
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Overview</h2>
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
            <span>Submit rate</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.acceptRate}%</strong>
            <span>Accept rate</span>
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

      <div className={styles.reportSplit}>
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>By person</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Person</th>
                <th>Shifts</th>
                <th>Avg %</th>
                <th>Open</th>
                <th>In</th>
                <th>OK</th>
                <th>No</th>
                <th>Late</th>
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
                          setPerson(b.key);
                          setPage(1);
                        }}
                      >
                        {b.label}
                      </button>
                    </td>
                    <td>{b.shifts}</td>
                    <td>
                      <span
                        className={
                          b.avgPct >= 80
                            ? styles.pctOk
                            : b.avgPct >= 40
                              ? styles.pctMid
                              : styles.pctLow
                        }
                      >
                        {b.avgPct}%
                      </span>
                    </td>
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
                    <td>
                      <span
                        className={
                          b.avgPct >= 80
                            ? styles.pctOk
                            : b.avgPct >= 40
                              ? styles.pctMid
                              : styles.pctLow
                        }
                      >
                        {b.avgPct}%
                      </span>
                    </td>
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
      </div>

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
              {stores.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.station_code}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Shift Incharge
            <select
              value={person}
              onChange={(e) => {
                setPerson(e.target.value);
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
                  {siStatusLabels[st]}
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
                setSort(e.target.value);
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
                      <span
                        className={`${styles.statusPill} ${
                          r.status === "open"
                            ? styles.statusOpen
                            : r.status === "submitted"
                              ? styles.statusSubmitted
                              : r.status === "accepted"
                                ? styles.statusAccepted
                                : r.status === "rejected"
                                  ? styles.statusRejected
                                  : styles.statusCancelled
                        }`}
                      >
                        {siStatusLabels[r.status]}
                      </span>
                      {r.escalate !== "none" ? (
                        <>
                          {" "}
                          <span
                            className={`${styles.statusPill} ${styles.statusSubmitted}`}
                          >
                            escalate {r.escalate}
                          </span>
                        </>
                      ) : null}
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
                        className={styles.btnTiny}
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
        <Pager page={paged.page} pages={paged.pages} setPage={setPage} />
      </section>
    </>
  );
}

function StoreReportBody({
  summary: s,
  rows,
  stores,
  store,
  setStore,
  person,
  setPerson,
  status,
  setStatus,
  sort,
  setSort,
  q,
  setQ,
  page,
  setPage,
}: {
  summary: StoreSummary;
  rows: StoreRow[];
  stores: Store[];
  store: string;
  setStore: (v: string) => void;
  person: string;
  setPerson: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  sort: string;
  setSort: (v: string) => void;
  q: string;
  setQ: (v: string) => void;
  page: number;
  setPage: (v: number | ((p: number) => number)) => void;
}) {
  const owners = useMemo(
    () =>
      [...new Map(rows.map((r) => [r.owner_user_id, r.owner_name])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );
  const filtered = useMemo(
    () =>
      sortStore(
        filterStore(rows, { store, owner: person, status, q }),
        sort as StoreSortKey,
      ),
    [rows, store, person, status, q, sort],
  );
  const paged = paginateRows(filtered, page, 20);

  return (
    <>
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Overview</h2>
        <div className={styles.kpiGrid}>
          <div className={styles.kpi}>
            <strong>{s.days}</strong>
            <span>Day checklists</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.avgPct}%</strong>
            <span>Avg completion</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.submitRate}%</strong>
            <span>Submit rate</span>
          </div>
          <div className={styles.kpi}>
            <strong>{s.open}</strong>
            <span>Still open</span>
          </div>
        </div>
      </section>

      <div className={styles.reportSplit}>
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>By person</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Owner</th>
                <th>Days</th>
                <th>Avg %</th>
                <th>Open</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {!s.byOwner.length ? (
                <tr>
                  <td colSpan={5}>No checklists in this range.</td>
                </tr>
              ) : (
                s.byOwner.map((b) => (
                  <tr key={b.key}>
                    <td>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => {
                          setPerson(b.key);
                          setPage(1);
                        }}
                      >
                        {b.label}
                      </button>
                    </td>
                    <td>{b.days}</td>
                    <td>
                      <span
                        className={
                          b.avgPct >= 80
                            ? styles.pctOk
                            : b.avgPct >= 40
                              ? styles.pctMid
                              : styles.pctLow
                        }
                      >
                        {b.avgPct}%
                      </span>
                    </td>
                    <td>{b.open}</td>
                    <td>{b.submitted}</td>
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
                <th>Days</th>
                <th>Avg %</th>
                <th>Open</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {!s.byStore.length ? (
                <tr>
                  <td colSpan={5}>No checklists in this range.</td>
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
                    <td>{b.days}</td>
                    <td>
                      <span
                        className={
                          b.avgPct >= 80
                            ? styles.pctOk
                            : b.avgPct >= 40
                              ? styles.pctMid
                              : styles.pctLow
                        }
                      >
                        {b.avgPct}%
                      </span>
                    </td>
                    <td>{b.open}</td>
                    <td>{b.submitted}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      </div>

      <section className={styles.panel}>
        <div className={styles.shiftListHead}>
          <h2 className={styles.sectionTitle}>Day detail</h2>
          <span className={styles.chip}>{filtered.length} shown</span>
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
              {stores.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.station_code}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Owner
            <select
              value={person}
              onChange={(e) => {
                setPerson(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {owners.map((x) => (
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
              {(["open", "submitted", "cancelled"] as const).map((st) => (
                <option key={st} value={st}>
                  {storeStatusLabels[st]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Sort
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
            >
              <option value="date_desc">Date · newest</option>
              <option value="date_asc">Date · oldest</option>
              <option value="pct_desc">Completion · high</option>
              <option value="pct_asc">Completion · low</option>
              <option value="owner">Owner</option>
              <option value="store">Store</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label className={styles.field}>
            Search
            <input
              value={q}
              placeholder="Store, owner…"
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
                <th>Day</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Completion</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!paged.rows.length ? (
                <tr>
                  <td colSpan={5}>No days match filters.</td>
                </tr>
              ) : (
                paged.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.store_code} · {r.work_date}
                    </td>
                    <td>{r.owner_name}</td>
                    <td>
                      <span
                        className={`${styles.statusPill} ${
                          r.status === "open"
                            ? styles.statusOpen
                            : r.status === "submitted"
                              ? styles.statusSubmitted
                              : styles.statusCancelled
                        }`}
                      >
                        {storeStatusLabels[r.status]}
                      </span>
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
                        className={styles.btnTiny}
                        href={`/store-ops?view=close&id=${r.id}`}
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
        <Pager page={paged.page} pages={paged.pages} setPage={setPage} />
      </section>
    </>
  );
}

function Pager({
  page,
  pages,
  setPage,
}: {
  page: number;
  pages: number;
  setPage: (v: number | ((p: number) => number)) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className={styles.pager}>
      <button
        type="button"
        className={styles.lineAdd}
        disabled={page <= 1}
        onClick={() => setPage((p) => Math.max(1, p - 1))}
      >
        Previous
      </button>
      <span>
        Page {page} / {pages}
      </span>
      <button
        type="button"
        className={styles.lineAdd}
        disabled={page >= pages}
        onClick={() => setPage((p) => Math.min(pages, p + 1))}
      >
        Next
      </button>
    </div>
  );
}

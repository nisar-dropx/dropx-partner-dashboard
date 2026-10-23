"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { statusLabels as siStatusLabels } from "@/lib/ops-pulse/si-handover/model";
import {
  filterProgressRows as filterSi,
  formatTrendDelta,
  paginateRows,
  sortProgressRows as sortSi,
  type ProgressRow as SiRow,
  type ReportSummary as SiSummary,
  type SortKey as SiSortKey,
} from "@/lib/ops-pulse/si-handover/report";
import { statusLabels as storeStatusLabels } from "@/lib/ops-pulse/store-ops/model";
import {
  filterProgressRows as filterStore,
  formatTrendDelta as formatStoreTrend,
  sortProgressRows as sortStore,
  type ProgressRow as StoreRow,
  type ReportSummary as StoreSummary,
  type SortKey as StoreSortKey,
} from "@/lib/ops-pulse/store-ops/report";
import { formatOpsDate } from "@/lib/ops-pulse/date-format";
import { ActivitiesHub } from "../activities-hub";
import { ChecklistReportModal } from "../checklist-report-modal";
import styles from "../si-handover.module.css";
import rui from "./report-ui.module.css";

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
  const [reportId, setReportId] = useState<string | null>(null);

  useEffect(() => {
    setFrom(props.from);
    setTo(props.to);
    setPage(1);
    setStore("");
    setPerson("");
    setStatus("");
    setSlot("");
    setQ("");
    setReportId(null);
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
  const rowCount = isShift
    ? props.shift?.rows.length || 0
    : props.store?.rows.length || 0;
  return (
    <div className={`${styles.pageWide} ${rui.shell}`}>
      <header className={rui.hero}>
        <p className={rui.eyebrow}>Dark Store · Activities & Handover</p>
        <h1>{isShift ? "Shift operations report" : "Store operations report"}</h1>
        <p>
          {isShift
            ? "What’s stuck, who’s quiet, what’s improving — then open any checklist as a report."
            : "What’s stuck, who’s quiet, what’s improving — then open any day checklist as a report."}
        </p>
        <div className={rui.heroMeta}>
          <span className={rui.metaPill}>
            Range <strong>{formatIstRange(from, to)}</strong>
          </span>
          <span className={rui.metaPill}>
            {isShift ? "Shifts" : "Days"} <strong>{rowCount}</strong>
          </span>
          <span className={rui.metaPill}>Timezone <strong>IST</strong></span>
        </div>
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
          onOpenReport={setReportId}
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
          onOpenReport={setReportId}
        />
      ) : null}

      <ChecklistReportModal
        kind={props.tab}
        checklistId={reportId}
        onClose={() => setReportId(null)}
      />
    </div>
  );
}

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function barClass(pct: number) {
  if (pct >= 80) return rui.bar;
  if (pct >= 50) return rui.barMid;
  return rui.barLow;
}

function heatClass(stale: number, open: number, active: boolean) {
  const base =
    stale > 0 ? rui.rankHot : open > 0 ? rui.rankWarm : rui.rank;
  return active ? `${base} ${rui.rankActive}` : base;
}

function rankAttention(stale: number, open: number) {
  if (stale > 0)
    return {
      flagClass: rui.flagBad,
      label: `${stale} stale${open ? ` · ${open} open` : ""}`,
    };
  if (open > 0) return { flagClass: rui.flagWarn, label: `${open} open` };
  return { flagClass: rui.flagOk, label: "On track" };
}

function sortBucketsForAttention<
  T extends { staleOpen: number; open: number; avgPct: number; label: string },
>(list: T[]) {
  return [...list].sort(
    (a, b) =>
      b.staleOpen - a.staleOpen ||
      b.open - a.open ||
      a.avgPct - b.avgPct ||
      a.label.localeCompare(b.label),
  );
}

function RankCard({
  index,
  label,
  detail,
  pct,
  stale,
  open,
  countLabel,
  trend,
  active,
  onClick,
}: {
  index: number;
  label: string;
  detail: string;
  pct: number;
  stale: number;
  open: number;
  countLabel: string;
  trend: string | null;
  active?: boolean;
  onClick: () => void;
}) {
  const attention = rankAttention(stale, open);
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <button
      type="button"
      className={heatClass(stale, open, Boolean(active))}
      onClick={onClick}
      aria-pressed={Boolean(active)}
    >
      <span className={rui.rankIndex}>{index}</span>
      <span className={rui.rankMain}>
        <strong>{label}</strong>
        <small>{detail}</small>
        <span className={barClass(safePct)} aria-hidden>
          <i className={rui.barFill} style={{ width: `${safePct}%` }} />
        </span>
        <span className={attention.flagClass}>{attention.label}</span>
      </span>
      <span className={rui.rankStats}>
        <span className={rui.rankPct}>{safePct}%</span>
        <span className={rui.rankMeta}>{countLabel}</span>
        {trend ? <span className={rui.rankMeta}>{trend}</span> : null}
      </span>
    </button>
  );
}

function networkTrendLabel(buckets: { trendDelta: number | null }[]) {
  const deltas = buckets
    .map((b) => b.trendDelta)
    .filter((d): d is number => d != null);
  if (!deltas.length) return null;
  const avg = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
  return formatTrendDelta(avg)?.replace(/^Trend\s*/, "") || null;
}

function EmptyInsight({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className={rui.empty}>
      <strong>{title}</strong>
      <p>{detail}</p>
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
  onOpenReport,
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
  onOpenReport: (id: string) => void;
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
  const storesRanked = useMemo(
    () => sortBucketsForAttention(s.byStore).slice(0, 8),
    [s.byStore],
  );
  const peopleRanked = useMemo(
    () => sortBucketsForAttention(s.bySi).slice(0, 8),
    [s.bySi],
  );
  const trendNet = networkTrendLabel(s.byStore);
  const feedItems = useMemo(
    () =>
      s.personActivity
        .flatMap((p) =>
          p.items.map((item) => ({ ...item, person: p.label })),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 12),
    [s.personActivity],
  );

  const storeLabel =
    stores.find((st) => st.id === store)?.station_code || store;
  const personLabel =
    sis.find((x) => x.id === person)?.name || person;
  const hasInsightFilters = Boolean(store || person || status || slot || q);

  return (
    <>
      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>Pulse</h2>
            <p>What’s stuck, who’s quiet, what’s improving</p>
          </div>
        </div>
        {!s.shifts ? (
          <EmptyInsight
            title="No shifts in this range"
            detail="Widen the date range or clear filters once data exists."
          />
        ) : (
          <div className={rui.pulseGrid} aria-label="Shift pulse">
            <div className={rui.pulseOk}>
              <p className={rui.pulseLabel}>Avg completion</p>
              <p className={rui.pulseValue}>{s.avgPct}%</p>
              <p className={rui.pulseHint}>
                {s.shifts} shifts · submit {s.submitRate}%
              </p>
            </div>
            <div className={s.open ? rui.pulseWarn : rui.pulse}>
              <p className={rui.pulseLabel}>Still open</p>
              <p className={rui.pulseValue}>{s.open}</p>
              <p className={rui.pulseHint}>
                Accept {s.acceptRate}% · overdue {s.overdueAccept}
              </p>
            </div>
            <div className={s.staleOpen ? rui.pulseBad : rui.pulseOk}>
              <p className={rui.pulseLabel}>Broken / stale</p>
              <p className={rui.pulseValue}>{s.staleOpen}</p>
              <p className={rui.pulseHint}>Quiet past escalate window</p>
            </div>
            <div className={rui.pulseOk}>
              <p className={rui.pulseLabel}>Trend vs prior</p>
              <p className={rui.pulseValue}>{trendNet || "—"}</p>
              <p className={rui.pulseHint}>
                {trendNet
                  ? "Same-length previous window"
                  : "No prior window to compare"}
              </p>
            </div>
          </div>
        )}
      </section>

      {hasInsightFilters ? (
        <div className={rui.filterChips} aria-label="Active filters">
          {store ? (
            <span className={rui.filterChip}>
              Store {storeLabel}
              <button
                type="button"
                aria-label="Clear store filter"
                onClick={() => {
                  setStore("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {person ? (
            <span className={rui.filterChip}>
              SI {personLabel}
              <button
                type="button"
                aria-label="Clear person filter"
                onClick={() => {
                  setPerson("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {status ? (
            <span className={rui.filterChip}>
              Status {status}
              <button
                type="button"
                aria-label="Clear status filter"
                onClick={() => {
                  setStatus("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {slot ? (
            <span className={rui.filterChip}>
              Slot {slot}
              <button
                type="button"
                aria-label="Clear slot filter"
                onClick={() => {
                  setSlot("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {q ? (
            <span className={rui.filterChip}>
              Search “{q}”
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className={rui.clearFilters}
            onClick={() => {
              setStore("");
              setPerson("");
              setStatus("");
              setSlot("");
              setQ("");
              setPage(1);
            }}
          >
            Clear all
          </button>
        </div>
      ) : null}

      <div className={rui.split}>
      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>By store</h2>
            <p>Worst open / stale first · click to filter detail</p>
          </div>
        </div>
        {!storesRanked.length ? (
          <EmptyInsight
            title="No stores to rank"
            detail="Checklists in this range will appear here."
          />
        ) : (
          <div className={rui.rankList}>
            {storesRanked.map((b, i) => (
              <RankCard
                key={b.key}
                index={i + 1}
                label={b.label}
                detail={`Last start ${formatWhen(b.firstStartedAt)}${
                  b.overdue ? ` · ${b.overdue} overdue accept` : ""
                }`}
                pct={b.avgPct}
                stale={b.staleOpen}
                open={b.open}
                countLabel={`${b.shifts} shifts`}
                trend={formatTrendDelta(b.trendDelta)}
                active={store === b.key}
                onClick={() => {
                  setStore(store === b.key ? "" : b.key);
                  setPage(1);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>By person</h2>
            <p>Done vs open · click to filter detail</p>
          </div>
        </div>
        {!peopleRanked.length ? (
          <EmptyInsight
            title="No people to rank"
            detail="SIs with shifts in this range will appear here."
          />
        ) : (
          <div className={rui.rankList}>
            {peopleRanked.map((b, i) => (
              <RankCard
                key={b.key}
                index={i + 1}
                label={b.label}
                detail={`Last update ${formatWhen(b.lastUpdatedAt)} · accepted ${b.accepted}`}
                pct={b.avgPct}
                stale={b.staleOpen}
                open={b.open}
                countLabel={`${b.shifts} shifts · open ${b.open}`}
                trend={formatTrendDelta(b.trendDelta)}
                active={person === b.key}
                onClick={() => {
                  setPerson(person === b.key ? "" : b.key);
                  setPage(1);
                }}
              />
            ))}
          </div>
        )}
      </section>
      </div>

      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>Person activity</h2>
            <p>Latest completed / missed / open · Open opens the report</p>
          </div>
        </div>
        {!feedItems.length ? (
          <EmptyInsight
            title="No activity yet"
            detail="When checklists move, their timeline shows up here."
          />
        ) : (
          <div className={rui.feed}>
            {feedItems.map((item) => (
              <div key={item.id} className={rui.feedItem}>
                <span
                  className={
                    item.kind === "completed"
                      ? rui.dotDone
                      : item.kind === "missed"
                        ? rui.dotMiss
                        : rui.dotOpen
                  }
                >
                  {item.kind === "completed"
                    ? "OK"
                    : item.kind === "missed"
                      ? "Miss"
                      : "Open"}
                </span>
                <div className={rui.feedBody}>
                  <strong>
                    {item.person} · {item.store_code} · {item.shift_date}{" "}
                    {item.shift_slot}
                  </strong>
                  <small>
                    {formatWhen(item.at)} · {item.pct}% ·{" "}
                    {siStatusLabels[item.status] || item.status}
                  </small>
                  <div className={rui.tags}>
                    <span
                      className={
                        item.kind === "completed"
                          ? rui.tagOk
                          : item.kind === "missed"
                            ? rui.tagWarn
                            : rui.tag
                      }
                    >
                      {item.kind}
                    </span>
                    <span className={rui.tag}>{item.pct}%</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={rui.openBtn}
                  onClick={() => onOpenReport(item.id)}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
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
                      <button
                        type="button"
                        className={rui.openBtn}
                        onClick={() => onOpenReport(r.id)}
                      >
                        Open report
                      </button>
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
  onOpenReport,
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
  onOpenReport: (id: string) => void;
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
  const storesRanked = useMemo(
    () => sortBucketsForAttention(s.byStore).slice(0, 8),
    [s.byStore],
  );
  const peopleRanked = useMemo(
    () => sortBucketsForAttention(s.byOwner).slice(0, 8),
    [s.byOwner],
  );
  const trendNet = networkTrendLabel(s.byStore);
  const feedItems = useMemo(
    () =>
      s.personActivity
        .flatMap((p) =>
          p.items.map((item) => ({ ...item, person: p.label })),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 12),
    [s.personActivity],
  );

  const storeLabel =
    stores.find((st) => st.id === store)?.station_code || store;
  const personLabel =
    owners.find((x) => x.id === person)?.name || person;
  const hasInsightFilters = Boolean(store || person || status || q);

  return (
    <>
      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>Pulse</h2>
            <p>What’s stuck, who’s quiet, what’s improving</p>
          </div>
        </div>
        {!s.days ? (
          <EmptyInsight
            title="No day checklists in this range"
            detail="Widen the date range or wait for store closes to land."
          />
        ) : (
          <div className={rui.pulseGrid} aria-label="Store pulse">
            <div className={rui.pulseOk}>
              <p className={rui.pulseLabel}>Avg completion</p>
              <p className={rui.pulseValue}>{s.avgPct}%</p>
              <p className={rui.pulseHint}>
                {s.days} days · submit {s.submitRate}%
              </p>
            </div>
            <div className={s.open ? rui.pulseWarn : rui.pulse}>
              <p className={rui.pulseLabel}>Still open</p>
              <p className={rui.pulseValue}>{s.open}</p>
              <p className={rui.pulseHint}>Needs finish or close</p>
            </div>
            <div className={s.staleOpen ? rui.pulseBad : rui.pulseOk}>
              <p className={rui.pulseLabel}>Broken / stale</p>
              <p className={rui.pulseValue}>{s.staleOpen}</p>
              <p className={rui.pulseHint}>Quiet past escalate window</p>
            </div>
            <div className={rui.pulseOk}>
              <p className={rui.pulseLabel}>Trend vs prior</p>
              <p className={rui.pulseValue}>{trendNet || "—"}</p>
              <p className={rui.pulseHint}>
                {trendNet
                  ? "Same-length previous window"
                  : "No prior window to compare"}
              </p>
            </div>
          </div>
        )}
      </section>

      {hasInsightFilters ? (
        <div className={rui.filterChips} aria-label="Active filters">
          {store ? (
            <span className={rui.filterChip}>
              Store {storeLabel}
              <button
                type="button"
                aria-label="Clear store filter"
                onClick={() => {
                  setStore("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {person ? (
            <span className={rui.filterChip}>
              Owner {personLabel}
              <button
                type="button"
                aria-label="Clear owner filter"
                onClick={() => {
                  setPerson("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {status ? (
            <span className={rui.filterChip}>
              Status {status}
              <button
                type="button"
                aria-label="Clear status filter"
                onClick={() => {
                  setStatus("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          {q ? (
            <span className={rui.filterChip}>
              Search “{q}”
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className={rui.clearFilters}
            onClick={() => {
              setStore("");
              setPerson("");
              setStatus("");
              setQ("");
              setPage(1);
            }}
          >
            Clear all
          </button>
        </div>
      ) : null}

      <div className={rui.split}>
      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>By store</h2>
            <p>Worst open / stale first · click to filter detail</p>
          </div>
        </div>
        {!storesRanked.length ? (
          <EmptyInsight
            title="No stores to rank"
            detail="Day checklists in this range will appear here."
          />
        ) : (
          <div className={rui.rankList}>
            {storesRanked.map((b, i) => (
              <RankCard
                key={b.key}
                index={i + 1}
                label={b.label}
                detail={`Last start ${formatWhen(b.firstStartedAt)}`}
                pct={b.avgPct}
                stale={b.staleOpen}
                open={b.open}
                countLabel={`${b.days} days`}
                trend={formatStoreTrend(b.trendDelta)}
                active={store === b.key}
                onClick={() => {
                  setStore(store === b.key ? "" : b.key);
                  setPage(1);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>By person</h2>
            <p>Done vs open · click to filter detail</p>
          </div>
        </div>
        {!peopleRanked.length ? (
          <EmptyInsight
            title="No people to rank"
            detail="Owners with days in this range will appear here."
          />
        ) : (
          <div className={rui.rankList}>
            {peopleRanked.map((b, i) => (
              <RankCard
                key={b.key}
                index={i + 1}
                label={b.label}
                detail={`Last update ${formatWhen(b.lastUpdatedAt)} · submitted ${b.submitted}`}
                pct={b.avgPct}
                stale={b.staleOpen}
                open={b.open}
                countLabel={`${b.days} days · open ${b.open}`}
                trend={formatStoreTrend(b.trendDelta)}
                active={person === b.key}
                onClick={() => {
                  setPerson(person === b.key ? "" : b.key);
                  setPage(1);
                }}
              />
            ))}
          </div>
        )}
      </section>
      </div>

      <section className={rui.card}>
        <div className={rui.cardHead}>
          <div>
            <h2>Person activity</h2>
            <p>Latest completed / missed / open · Open opens the report</p>
          </div>
        </div>
        {!feedItems.length ? (
          <EmptyInsight
            title="No activity yet"
            detail="When day checklists move, their timeline shows up here."
          />
        ) : (
          <div className={rui.feed}>
            {feedItems.map((item) => (
              <div key={item.id} className={rui.feedItem}>
                <span
                  className={
                    item.kind === "completed"
                      ? rui.dotDone
                      : item.kind === "missed"
                        ? rui.dotMiss
                        : rui.dotOpen
                  }
                >
                  {item.kind === "completed"
                    ? "OK"
                    : item.kind === "missed"
                      ? "Miss"
                      : "Open"}
                </span>
                <div className={rui.feedBody}>
                  <strong>
                    {item.person} · {item.store_code} · {item.work_date}
                  </strong>
                  <small>
                    {formatWhen(item.at)} · {item.pct}% ·{" "}
                    {storeStatusLabels[item.status] || item.status}
                  </small>
                  <div className={rui.tags}>
                    <span
                      className={
                        item.kind === "completed"
                          ? rui.tagOk
                          : item.kind === "missed"
                            ? rui.tagWarn
                            : rui.tag
                      }
                    >
                      {item.kind}
                    </span>
                    <span className={rui.tag}>{item.pct}%</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={rui.openBtn}
                  onClick={() => onOpenReport(item.id)}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

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
                      <button
                        type="button"
                        className={rui.openBtn}
                        onClick={() => onOpenReport(r.id)}
                      >
                        Open report
                      </button>
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

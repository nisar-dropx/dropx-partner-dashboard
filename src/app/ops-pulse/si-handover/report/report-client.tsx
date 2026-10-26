"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { statusLabels as siStatusLabels } from "@/lib/ops-pulse/si-handover/model";
import {
  buildStoreContinuity,
  filterProgressRows as filterSi,
  formatTrendDelta,
  paginateRows,
  sortProgressRows as sortSi,
  type ProgressRow as SiRow,
  type ReportSummary as SiSummary,
  type SortKey as SiSortKey,
  type StoreContinuityBoard,
} from "@/lib/ops-pulse/si-handover/report";
import type {
  ContinuityCellKind,
  StoreContinuityHealth,
  StoreContinuityRow,
} from "@/lib/ops-pulse/si-handover/report-insights";
import { statusLabels as storeStatusLabels } from "@/lib/ops-pulse/store-ops/model";
import {
  filterProgressRows as filterStore,
  formatTrendDelta as formatStoreTrend,
  sortProgressRows as sortStore,
  type ProgressRow as StoreRow,
  type ReportSummary as StoreSummary,
  type SortKey as StoreSortKey,
} from "@/lib/ops-pulse/store-ops/report";
import { lockBodyScroll, resetBodyScrollLock } from "@/lib/body-scroll-lock";
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
  showShiftReport?: boolean;
  showStoreReport?: boolean;
  shift?: {
    summary: SiSummary;
    rows: SiRow[];
    stores: Store[];
    shiftSlots?: string[];
  };
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
  { id: "yesterday", label: "Yesterday", days: 0, offset: -1 },
  { id: "today", label: "Today", days: 0, offset: 0 },
  { id: "7d", label: "7d", days: 6, offset: 0 },
  { id: "14d", label: "14d", days: 13, offset: 0 },
  { id: "30d", label: "30d", days: 29, offset: 0 },
] as const;

function pctClass(pct: number) {
  if (pct >= 80) return rui.pctOk;
  if (pct >= 40) return rui.pctMid;
  return rui.pctLow;
}

function barClass(pct: number) {
  if (pct >= 80) return rui.bar;
  if (pct >= 50) return rui.barMid;
  return rui.barLow;
}

function trendClass(delta: number | null) {
  if (delta == null) return rui.trendFlat;
  if (delta > 0) return rui.trendUp;
  if (delta < 0) return rui.trendDown;
  return rui.trendFlat;
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

function sortBuckets<
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

export function ActivitiesReportClient(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(props.from);
  const [to, setTo] = useState(props.to);
  const searchParams = useSearchParams();
  const [store, setStore] = useState(searchParams.get("store") || "");
  const [person, setPerson] = useState("");
  const [status, setStatus] = useState("");
  const [slot, setSlot] = useState("");
  const [sort, setSort] = useState<string>("date_desc");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [reportId, setReportId] = useState<string | null>(null);

  useEffect(() => {
    // Recover if a prior modal race left the page unscrollable.
    resetBodyScrollLock();
  }, []);

  useEffect(() => {
    setFrom(props.from);
    setTo(props.to);
    setPage(1);
    setStore(searchParams.get("store") || "");
    setPerson("");
    setStatus("");
    setSlot("");
    setQ("");
    setReportId(null);
  }, [props.from, props.to, props.tab, searchParams]);

  const pushRange = (nextFrom: string, nextTo: string) => {
    start(() => {
      const params = new URLSearchParams();
      params.set("tab", props.tab);
      if (nextFrom) params.set("from", nextFrom);
      if (nextTo) params.set("to", nextTo);
      if (store) params.set("store", store);
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

  const applyPreset = (daysBack: number, offset = 0) => {
    const end = addDaysIst(istToday(), offset);
    const start = addDaysIst(end, -daysBack);
    setFrom(start);
    setTo(end);
    pushRange(start, end);
  };

  const activePreset = RANGE_PRESETS.find((p) => {
    const end = addDaysIst(istToday(), p.offset);
    const start = addDaysIst(end, -p.days);
    return from === start && to === end;
  });

  const isShift = props.tab === "shift";
  const rowCount = isShift
    ? props.shift?.rows.length || 0
    : props.store?.rows.length || 0;

  return (
    <div
      className={`${styles.pageWide} ${rui.shell}${pending ? ` ${rui.pending}` : ""}`}
    >
      <header className={rui.head}>
        <div className={rui.headLeft}>
          <p className={rui.eyebrow}>Dark Store · Activities & Handover</p>
          <h1>
            {isShift ? "Shift operations report" : "Store operations report"}
          </h1>
          <p className={rui.sub}>
            Who’s on track, who’s stuck, and where to follow up — then open any
            checklist.
          </p>
        </div>
        <div className={rui.meta}>
          <span className={rui.pill}>
            Range <strong>{formatIstRange(from, to)}</strong>
          </span>
          <span className={rui.pill}>
            {isShift ? "Shifts" : "Days"} <strong>{rowCount}</strong>
          </span>
          <span className={rui.pill}>
            TZ <strong>IST</strong>
          </span>
        </div>
      </header>

      <ActivitiesHub
        active={isShift ? "shift-report" : "store-report"}
        showShift={props.showShift}
        showStore={props.showStore}
        showShiftReport={props.showShiftReport ?? props.showShift}
        showStoreReport={props.showStoreReport ?? props.showStore}
      />

      <section className={rui.toolbar}>
        <div className={rui.presets} role="group" aria-label="Quick ranges">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={activePreset?.id === p.id ? rui.presetOn : rui.preset}
              disabled={pending}
              onClick={() => applyPreset(p.days, p.offset)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className={rui.field}>
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className={rui.field}>
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
          className={rui.applyBtn}
          disabled={pending || (!from && !to)}
          onClick={applyRange}
        >
          {pending ? "…" : "Apply"}
        </button>
        <span className={rui.kindChip}>
          {isShift ? "Shift handovers" : "Store day checklists"}
        </span>
      </section>

      {isShift && props.shift ? (
        <ShiftReportBody
          summary={props.shift.summary}
          rows={props.shift.rows}
          stores={props.shift.stores}
          shiftSlots={props.shift.shiftSlots || []}
          from={props.from}
          to={props.to}
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

      {!isShift && props.store ? (
        <StoreReportBody
          summary={props.store.summary}
          rows={props.store.rows}
          stores={props.store.stores}
          from={props.from}
          to={props.to}
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

function FilterChips({
  items,
  onClearAll,
}: {
  items: { key: string; label: string; onClear: () => void }[];
  onClearAll: () => void;
}) {
  if (!items.length) return null;
  return (
    <div className={rui.filterChips} aria-label="Active filters">
      {items.map((item) => (
        <span key={item.key} className={rui.filterChip}>
          {item.label}
          <button type="button" aria-label={`Clear ${item.label}`} onClick={item.onClear}>
            ×
          </button>
        </span>
      ))}
      <button type="button" className={rui.clearFilters} onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}

function continuityCellClass(kind: ContinuityCellKind) {
  switch (kind) {
    case "accepted":
      return rui.contCellOk;
    case "submitted":
      return rui.contCellSubmit;
    case "open":
      return rui.contCellOpen;
    case "stale":
      return rui.contCellStale;
    case "rejected":
      return rui.contCellBad;
    case "cancelled":
      return rui.contCellCancel;
    default:
      return rui.contCellMiss;
  }
}

function continuityCellLabel(kind: ContinuityCellKind) {
  switch (kind) {
    case "accepted":
      return "OK";
    case "submitted":
      return "Sub";
    case "open":
      return "Open";
    case "stale":
      return "Stale";
    case "rejected":
      return "Rej";
    case "cancelled":
      return "Can";
    default:
      return "—";
  }
}

function healthClass(health: StoreContinuityHealth) {
  switch (health) {
    case "continuous":
      return rui.contHealthOk;
    case "in_progress":
      return rui.contHealthProg;
    case "at_risk":
      return rui.contHealthRisk;
    case "broken":
      return rui.contHealthBad;
    default:
      return rui.contHealthEmpty;
  }
}

function healthLabel(health: StoreContinuityHealth) {
  switch (health) {
    case "continuous":
      return "Continuous";
    case "in_progress":
      return "In progress";
    case "at_risk":
      return "At risk";
    case "broken":
      return "Broken";
    default:
      return "No shifts";
  }
}

function StoreContinuityPanel({
  board,
  mode = "shift",
  activeStoreId,
  onSelectStore,
  onClearStoreFilter,
  onOpenReport,
}: {
  board: StoreContinuityBoard;
  mode?: "shift" | "store";
  activeStoreId: string;
  onSelectStore: (locationId: string) => void;
  onClearStoreFilter: () => void;
  onOpenReport: (id: string) => void;
}) {
  const multiDay = board.dates.length > 1;
  const isStore = mode === "store";
  const [detailRow, setDetailRow] = useState<StoreContinuityRow | null>(null);

  useEffect(() => {
    // Range/data refresh: keep modal on the same store if it still exists.
    setDetailRow((prev) => {
      if (!prev) return null;
      return board.stores.find((s) => s.locationId === prev.locationId) || null;
    });
  }, [board]);

  const openStoreDetail = (row: StoreContinuityRow) => {
    setDetailRow(row);
    onSelectStore(row.locationId);
  };

  return (
    <section
      className={rui.contPanel}
      aria-label={isStore ? "Store day continuity" : "Store shift continuity"}
    >
      <div className={rui.contHead}>
        <div>
          <h2>{isStore ? "Store day continuity" : "Store shift continuity"}</h2>
          <p>
            {isStore
              ? `Every store × every day${multiDay ? ` across ${board.dates.length} days` : ""} — gaps, stale opens, and submitted closes.`
              : `Every store × every configured slot${multiDay ? ` across ${board.dates.length} days` : " for this day"} — gaps, stale opens, and unbroken handovers.`}{" "}
            Click a store card for the full day-by-day view.
          </p>
        </div>
        <div className={rui.contSummary}>
          <span className={rui.contStat}>
            <strong>{board.continuityPct}%</strong>
            {isStore ? "submitted" : "accepted"}
          </span>
          <span className={rui.contStat}>
            <strong>
              {board.covered}/{board.expected}
            </strong>
            covered
          </span>
          <span className={rui.contStatWarn}>
            <strong>{board.missing}</strong>
            gaps
          </span>
          <span className={rui.contStatOk}>
            <strong>{board.continuousStores}</strong>
            continuous
          </span>
          <span className={rui.contStatRisk}>
            <strong>{board.atRiskStores}</strong>
            in flight
          </span>
          <span className={rui.contStatBad}>
            <strong>{board.brokenStores}</strong>
            broken
          </span>
        </div>
      </div>

      <div className={rui.contLegend} aria-label="Legend">
        <span className={rui.contCellOk}>{isStore ? "Submitted" : "OK"}</span>
        {!isStore ? <span className={rui.contCellSubmit}>Submitted</span> : null}
        <span className={rui.contCellOpen}>Open</span>
        <span className={rui.contCellStale}>Stale</span>
        <span className={rui.contCellMiss}>Missing</span>
        {!isStore ? <span className={rui.contCellBad}>Rejected</span> : null}
      </div>

      {!board.stores.length ? (
        <div className={rui.empty}>
          <strong>No stores in scope</strong>
          Adjust location scope to see continuity.
        </div>
      ) : (
        <div className={rui.contGrid}>
          {board.stores.map((row) => (
            <StoreContinuityCard
              key={row.locationId}
              row={row}
              dates={board.dates}
              mode={mode}
              active={activeStoreId === row.locationId}
              onSelect={() => openStoreDetail(row)}
              onOpenReport={onOpenReport}
            />
          ))}
        </div>
      )}

      {detailRow ? (
        <StoreContinuityDaysModal
          row={detailRow}
          slots={board.slots}
          dates={board.dates}
          mode={mode}
          onClose={() => setDetailRow(null)}
          onOpenReport={(id) => {
            // Close continuity first so the checklist report is not trapped under it.
            setDetailRow(null);
            onOpenReport(id);
          }}
          onClearFilter={() => {
            onClearStoreFilter();
            setDetailRow(null);
          }}
        />
      ) : null}
    </section>
  );
}

function StoreContinuityDaysModal({
  row,
  slots,
  dates,
  mode = "shift",
  onClose,
  onOpenReport,
  onClearFilter,
}: {
  row: StoreContinuityRow;
  slots: string[];
  dates: string[];
  mode?: "shift" | "store";
  onClose: () => void;
  onOpenReport: (id: string) => void;
  onClearFilter: () => void;
}) {
  const isStore = mode === "store";
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const daySections = useMemo(() => {
    // Newest first so “last 7 days” opens on the latest day.
    return [...dates].reverse().map((date) => {
      const cells = row.cells.filter((c) => c.date === date);
      const bySlot = new Map(cells.map((c) => [c.slot, c]));
      const ordered = slots.map(
        (slot) =>
          bySlot.get(slot) || {
            date,
            slot,
            kind: "missing" as ContinuityCellKind,
            checklistId: null,
            pct: 0,
            siName: null,
          },
      );
      const health = dayHealthFromCells(ordered);
      const covered = ordered.filter((c) => c.kind !== "missing").length;
      const missing = ordered.filter((c) => c.kind === "missing").length;
      const accepted = ordered.filter((c) => c.kind === "accepted").length;
      const stale = ordered.filter((c) => c.kind === "stale").length;
      return { date, cells: ordered, health, covered, missing, accepted, stale };
    });
  }, [dates, row.cells, slots]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
    const unlock = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
    };
  }, []);

  const rangeLabel =
    dates.length <= 1
      ? formatOpsDate(dates[0] || "")
      : `${formatOpsDate(dates[0] || "")} → ${formatOpsDate(dates[dates.length - 1] || "")}`;

  return (
    <div
      className={rui.contModalBackdrop}
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={rui.contModal}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={rui.contModalHead}>
          <div>
            <p className={rui.contModalEyebrow}>
              {isStore ? "Store day continuity" : "Store shift continuity"}
            </p>
            <h2 id={titleId} className={rui.contModalTitle}>
              {row.storeCode}
            </h2>
            <p className={rui.contModalMeta}>
              {rangeLabel} · {dates.length} day{dates.length === 1 ? "" : "s"}
              {!isStore
                ? ` · ${slots.length} slot${slots.length === 1 ? "" : "s"}/day`
                : ""}{" "}
              ·{" "}
              <span className={healthClass(row.health)}>
                {healthLabel(row.health)}
              </span>
            </p>
          </div>
          <div className={rui.contModalActions}>
            <button
              type="button"
              className={rui.openBtn}
              onClick={() => {
                onClearFilter();
                onClose();
              }}
            >
              Clear filter
            </button>
            <button
              ref={closeRef}
              type="button"
              className={rui.openBtnPrimary}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>

        <div className={rui.contModalSummary}>
          <span>
            <strong>{row.continuityPct}%</strong>
            <small>{isStore ? "Submitted" : "Accepted"}</small>
          </span>
          <span>
            <strong>
              {row.covered}/{row.expected}
            </strong>
            <small>Covered</small>
          </span>
          <span>
            <strong>{row.missing}</strong>
            <small>Gaps</small>
          </span>
          <span>
            <strong>{row.stale}</strong>
            <small>Stale</small>
          </span>
          <span>
            <strong>{row.open}</strong>
            <small>Open</small>
          </span>
          <span>
            <strong>{row.rejected}</strong>
            <small>Rejected</small>
          </span>
        </div>

        <div className={rui.contModalBody}>
          {!daySections.length ? (
            <div className={rui.empty}>
              <strong>No days in range</strong>
              Pick a valid From / To window.
            </div>
          ) : (
            daySections.map((day) => (
              <section key={day.date} className={rui.contDayBlock}>
                <div className={rui.contDayHead}>
                  <div>
                    <strong>{formatOpsDate(day.date)}</strong>
                    <span className={rui.contModalMeta}>
                      {isStore
                        ? `${day.covered ? "Checklist on file" : "No checklist"} · ${day.accepted ? "submitted" : day.stale ? "stale" : day.covered ? "open" : "missing"}`
                        : `${day.covered}/${day.cells.length} slots · ${day.accepted} accepted`}
                      {day.missing && !isStore ? ` · ${day.missing} gap` : ""}
                      {day.stale ? ` · ${day.stale} stale` : ""}
                    </span>
                  </div>
                  <span className={healthClass(day.health)}>
                    {healthLabel(day.health)}
                  </span>
                </div>
                <div className={rui.contDaySlots}>
                  {day.cells.map((cell) => {
                    const title = [
                      isStore ? cell.date : `${cell.date} ${cell.slot}`,
                      cell.kind,
                      cell.siName
                        ? `${isStore ? "Owner" : "SI"} ${cell.siName}`
                        : null,
                      cell.pct ? `${cell.pct}%` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div
                        key={`${cell.date}-${cell.slot}`}
                        className={`${rui.contDaySlot} ${continuityCellClass(cell.kind)}`}
                        title={title}
                      >
                        <div className={rui.contDaySlotTop}>
                          <strong>{isStore ? "Day checklist" : cell.slot}</strong>
                          <span>
                            {isStore && cell.kind === "accepted"
                              ? "Done"
                              : continuityCellLabel(cell.kind)}
                          </span>
                        </div>
                        <div className={rui.contDaySlotBody}>
                          {cell.kind === "missing" ? (
                            <span className={rui.muted}>No checklist started</span>
                          ) : (
                            <>
                              <span>
                                {cell.siName || "—"} · {cell.pct}%
                              </span>
                              {cell.checklistId ? (
                                <button
                                  type="button"
                                  className={rui.openBtnPrimary}
                                  onClick={() => onOpenReport(cell.checklistId!)}
                                >
                                  Open report
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function dayHealthFromCells(
  cells: StoreContinuityRow["cells"],
): StoreContinuityHealth {
  const expected = cells.length;
  const missing = cells.filter((c) => c.kind === "missing").length;
  const covered = expected - missing;
  const accepted = cells.filter((c) => c.kind === "accepted").length;
  const open = cells.filter((c) => c.kind === "open").length;
  const stale = cells.filter((c) => c.kind === "stale").length;
  const rejected = cells.filter((c) => c.kind === "rejected").length;
  if (expected <= 0 || covered === 0) return "empty";
  if (missing > 0 || rejected > 0) return "broken";
  if (stale > 0) return "at_risk";
  if (accepted === expected) return "continuous";
  return open > 0 || accepted < covered ? "in_progress" : "continuous";
}

function StoreContinuityCard({
  row,
  dates,
  mode = "shift",
  active,
  onSelect,
  onOpenReport,
}: {
  row: StoreContinuityRow;
  dates: string[];
  mode?: "shift" | "store";
  active: boolean;
  onSelect: () => void;
  onOpenReport: (id: string) => void;
}) {
  const multiDay = dates.length > 1;
  const isStore = mode === "store";
  const latestDate = dates[dates.length - 1] || "";
  const detailCells = multiDay
    ? row.cells.filter((c) => c.date === latestDate)
    : row.cells;
  const dayDots = multiDay
    ? dates.map((date) => {
        const dayCells = row.cells.filter((c) => c.date === date);
        return { date, health: dayHealthFromCells(dayCells) };
      })
    : [];

  return (
    <article
      className={active ? `${rui.contCard} ${rui.contCardActive}` : rui.contCard}
    >
      <button type="button" className={rui.contCardHead} onClick={onSelect}>
        <span className={rui.contStore}>{row.storeCode}</span>
        <span className={healthClass(row.health)}>{healthLabel(row.health)}</span>
        <span className={rui.contPct}>{row.continuityPct}%</span>
      </button>
      <div className={rui.contMeta}>
        <span>
          {row.covered}/{row.expected} {isStore ? "days" : "slots"}
        </span>
        {row.missing ? <span className={rui.contGap}>{row.missing} gap</span> : null}
        {row.stale ? <span className={rui.contGap}>{row.stale} stale</span> : null}
        {multiDay ? (
          <span>Latest {latestDate.slice(5)}</span>
        ) : null}
      </div>
      {multiDay ? (
        <button
          type="button"
          className={rui.contDays}
          aria-label={`Open ${row.storeCode} day continuity`}
          onClick={onSelect}
        >
          {dayDots.map((d) => (
            <span
              key={d.date}
              title={`${d.date} · ${healthLabel(d.health)}`}
              className={`${rui.contDayDot} ${healthClass(d.health)}`}
            />
          ))}
        </button>
      ) : null}
      <div className={rui.contSlots} role="list">
        {detailCells.map((cell) => {
          const title = [
            `${cell.date} ${cell.slot}`,
            cell.kind,
            cell.siName ? `SI ${cell.siName}` : null,
            cell.pct ? `${cell.pct}%` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const body = (
            <>
              <span className={rui.contSlotTime}>
                {isStore ? formatOpsDate(cell.date, cell.date) : cell.slot}
              </span>
              <span className={rui.contSlotState}>
                {isStore && cell.kind === "accepted"
                  ? "Done"
                  : continuityCellLabel(cell.kind)}
              </span>
              {cell.kind !== "missing" ? (
                <span className={rui.contSlotPct}>{cell.pct}%</span>
              ) : null}
            </>
          );
          if (cell.checklistId) {
            return (
              <button
                key={`${cell.date}-${cell.slot}`}
                type="button"
                role="listitem"
                title={title}
                className={continuityCellClass(cell.kind)}
                onClick={() => onOpenReport(cell.checklistId!)}
              >
                {body}
              </button>
            );
          }
          return (
            <div
              key={`${cell.date}-${cell.slot}`}
              role="listitem"
              title={title}
              className={continuityCellClass(cell.kind)}
            >
              {body}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ShiftReportBody({
  summary: s,
  rows,
  stores,
  shiftSlots,
  from,
  to,
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
  shiftSlots: string[];
  from: string;
  to: string;
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
  const paged = paginateRows(filtered, page, 25);
  const people = useMemo(() => sortBuckets(s.bySi), [s.bySi]);
  const byStore = useMemo(() => sortBuckets(s.byStore), [s.byStore]);
  const continuity = useMemo(
    () =>
      buildStoreContinuity({
        stores: stores.map((st) => ({
          id: st.id,
          station_code: st.station_code,
        })),
        rows,
        slots: shiftSlots,
        from,
        to,
      }),
    [stores, rows, shiftSlots, from, to],
  );
  const feedItems = useMemo(
    () =>
      s.personActivity
        .flatMap((p) => p.items.map((item) => ({ ...item, person: p.label })))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 8),
    [s.personActivity],
  );

  const storeLabel =
    stores.find((st) => st.id === store)?.station_code || store;
  const personLabel = sis.find((x) => x.id === person)?.name || person;
  const chips = [
    store
      ? {
          key: "store",
          label: `Store ${storeLabel}`,
          onClear: () => {
            setStore("");
            setPage(1);
          },
        }
      : null,
    person
      ? {
          key: "person",
          label: `SI ${personLabel}`,
          onClear: () => {
            setPerson("");
            setPage(1);
          },
        }
      : null,
    status
      ? {
          key: "status",
          label: `Status ${status}`,
          onClear: () => {
            setStatus("");
            setPage(1);
          },
        }
      : null,
    slot
      ? {
          key: "slot",
          label: `Slot ${slot}`,
          onClear: () => {
            setSlot("");
            setPage(1);
          },
        }
      : null,
    q
      ? {
          key: "q",
          label: `“${q}”`,
          onClear: () => {
            setQ("");
            setPage(1);
          },
        }
      : null,
  ].filter(Boolean) as { key: string; label: string; onClear: () => void }[];

  return (
    <>
      <section className={rui.panel}>
        <div className={rui.panelHead}>
          <h2>Overview</h2>
          <p>Same-length prior window for trend</p>
        </div>
        {!s.shifts ? (
          <div className={rui.empty}>
            <strong>No shifts in this range</strong>
            Widen the date range or wait for activity.
          </div>
        ) : (
          <div className={rui.kpiGrid} aria-label="Shift overview">
            <div className={rui.kpi}>
              <strong>{s.shifts}</strong>
              <span>Reports started</span>
            </div>
            <div className={s.avgPct >= 80 ? rui.kpiOk : s.avgPct >= 40 ? rui.kpiWarn : rui.kpiBad}>
              <strong>{s.avgPct}%</strong>
              <span>Avg completion</span>
            </div>
            <div className={rui.kpi}>
              <strong>{s.shifts ? Math.round(100 * (s.submitted + s.accepted) / s.shifts) : 0}%</strong>
              <span>Currently submitted</span>
            </div>
            <div className={rui.kpi}>
              <strong>{s.submitted + s.accepted ? Math.round(100 * s.accepted / (s.submitted + s.accepted)) : 0}%</strong>
              <span>Submitted handovers accepted</span>
            </div>
            <div className={s.open ? rui.kpiWarn : rui.kpi}>
              <strong>{s.open}</strong>
              <span>Still open</span>
            </div>
            <div className={s.staleOpen || s.overdueAccept ? rui.kpiBad : rui.kpi}>
              <strong>{s.staleOpen || s.overdueAccept}</strong>
              <span>
                {s.staleOpen ? "Stale / broken" : "Overdue accept"}
              </span>
            </div>
          </div>
        )}
      </section>

      <StoreContinuityPanel
        board={continuity}
        activeStoreId={store}
        onSelectStore={(locationId) => {
          setStore(locationId);
          setPage(1);
        }}
        onClearStoreFilter={() => {
          setStore("");
          setPage(1);
        }}
        onOpenReport={onOpenReport}
      />

      <FilterChips
        items={chips}
        onClearAll={() => {
          setStore("");
          setPerson("");
          setStatus("");
          setSlot("");
          setQ("");
          setPage(1);
        }}
      />

      <div className={rui.split}>
        <section className={rui.panel}>
          <div className={rui.panelHead}>
            <h2>People & stores</h2>
            <span className={rui.count}>{people.length}</span>
          </div>
          <div className={rui.tableWrap}>
            <table className={rui.table}>
              <thead>
                <tr>
                  <th>Person</th>
                  <th title="Submitted / started reports">Submitted</th>
                  <th>Avg %</th>
                  <th>Open</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {!people.length ? (
                  <tr>
                    <td colSpan={5}>No people in range.</td>
                  </tr>
                ) : (
                  people.map((b) => (
                    <tr key={b.key}>
                      <td>
                        <button
                          type="button"
                          className={
                            person === b.key ? rui.linkBtnActive : rui.linkBtn
                          }
                          onClick={() => {
                            setPerson(person === b.key ? "" : b.key);
                            setPage(1);
                          }}
                        >
                          {b.label}
                        </button>
                        <small className={rui.personStores}>{[...new Set(rows.filter(r => (r.outgoing_user_id || r.outgoing_name) === b.key).map(r => { const st = stores.find(s => s.id === r.location_id); return `${r.store_code}${st?.station_name ? ` · ${st.station_name}` : ""}`; }))].join(" · ")}</small>
                      </td>
                      <td className={rui.num}>{b.submitted + b.accepted}/{b.shifts}</td>
                      <td>
                        <span className={pctClass(b.avgPct)}>{b.avgPct}%</span>
                      </td>
                      <td className={rui.num}>
                        {b.open}
                        {b.staleOpen ? (
                          <span className={rui.muted}> · {b.staleOpen} stale</span>
                        ) : null}
                      </td>
                      <td className={trendClass(b.trendDelta)}>
                        {formatTrendDelta(b.trendDelta)?.replace(/^Trend\s*/, "") ||
                          "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={rui.panel}>
          <div className={rui.panelHead}>
            <h2>By store</h2>
            <span className={rui.count}>{byStore.length}</span>
          </div>
          <div className={rui.tableWrap}>
            <table className={rui.table}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Shifts</th>
                  <th>Avg %</th>
                  <th>Open</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {!byStore.length ? (
                  <tr>
                    <td colSpan={5}>No stores in range.</td>
                  </tr>
                ) : (
                  byStore.map((b) => (
                    <tr key={b.key}>
                      <td>
                        <button
                          type="button"
                          className={
                            store === b.key ? rui.linkBtnActive : rui.linkBtn
                          }
                          onClick={() => {
                            setStore(store === b.key ? "" : b.key);
                            setPage(1);
                          }}
                        >
                          {b.label}
                        </button>
                      </td>
                      <td className={rui.num}>{b.shifts}</td>
                      <td>
                        <span className={pctClass(b.avgPct)}>{b.avgPct}%</span>
                      </td>
                      <td className={rui.num}>
                        {b.open}
                        {b.staleOpen ? (
                          <span className={rui.muted}> · {b.staleOpen} stale</span>
                        ) : null}
                      </td>
                      <td className={trendClass(b.trendDelta)}>
                        {formatTrendDelta(b.trendDelta)?.replace(/^Trend\s*/, "") ||
                          "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <details className={rui.panel}>
        <summary className={rui.panelHead}>
          <div>
            <h2>Recent reporting activity</h2>
            <p>Latest missed / open / completed</p>
          </div>
        </summary>
        {!feedItems.length ? (
          <div className={rui.empty}>No recent activity.</div>
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
      </details>

      <section className={rui.panel}>
        <div className={rui.panelHead}>
          <div>
            <h2>Shift detail</h2>
            <p>
              {filtered.length} shown · slots{" "}
              {s.bySlot.map((b) => `${b.label}:${b.shifts}`).join(" · ") || "—"}
            </p>
          </div>
        </div>
        <div className={rui.filterBar}>
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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

        <div className={`${rui.tableWrap} ${rui.tableWideWrap}`}>
          <table className={`${rui.table} ${rui.tableWide}`}>
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
                        className={
                          r.status === "open"
                            ? rui.statusOpen
                            : r.status === "submitted"
                              ? rui.statusSubmitted
                              : r.status === "accepted"
                                ? rui.statusAccepted
                                : r.status === "rejected"
                                  ? rui.statusRejected
                                  : rui.statusCancelled
                        }
                      >
                        {siStatusLabels[r.status]}
                      </span>
                      {r.escalate !== "none" ? (
                        <span className={rui.escalatePill}>
                          escalate {r.escalate}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <div className={rui.completionCell}>
                        <span className={pctClass(r.pct)}>{r.pct}%</span>
                        <span className={rui.muted}>
                          {r.answered}/{r.total}
                        </span>
                        <span className={barClass(r.pct)} aria-hidden>
                          <i
                            className={rui.barFill}
                            style={{
                              width: `${Math.max(0, Math.min(100, r.pct))}%`,
                            }}
                          />
                        </span>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={rui.openBtnPrimary}
                        onClick={() => onOpenReport(r.id)}
                      >
                        Open
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
  from,
  to,
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
  from: string;
  to: string;
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
  const paged = paginateRows(filtered, page, 25);
  const people = useMemo(() => sortBuckets(s.byOwner), [s.byOwner]);
  const byStore = useMemo(() => sortBuckets(s.byStore), [s.byStore]);
  // One checklist per store per day — reuse shift continuity with a single "Day" slot.
  // Submitted store days count as complete (mapped to accepted for scoring).
  const continuity = useMemo(
    () =>
      buildStoreContinuity({
        stores: stores.map((st) => ({
          id: st.id,
          station_code: st.station_code,
        })),
        rows: rows.map((r) => ({
          id: r.id,
          location_id: r.location_id,
          store_code: r.store_code,
          shift_date: r.work_date,
          shift_slot: "Day",
          status: r.status === "submitted" ? "accepted" : r.status,
          pct: r.pct,
          staleOpen: r.staleOpen,
          outgoing_name: r.owner_name,
        })),
        slots: ["Day"],
        from,
        to,
      }),
    [stores, rows, from, to],
  );
  const feedItems = useMemo(
    () =>
      s.personActivity
        .flatMap((p) => p.items.map((item) => ({ ...item, person: p.label })))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 8),
    [s.personActivity],
  );

  const storeLabel =
    stores.find((st) => st.id === store)?.station_code || store;
  const personLabel = owners.find((x) => x.id === person)?.name || person;
  const chips = [
    store
      ? {
          key: "store",
          label: `Store ${storeLabel}`,
          onClear: () => {
            setStore("");
            setPage(1);
          },
        }
      : null,
    person
      ? {
          key: "person",
          label: `Owner ${personLabel}`,
          onClear: () => {
            setPerson("");
            setPage(1);
          },
        }
      : null,
    status
      ? {
          key: "status",
          label: `Status ${status}`,
          onClear: () => {
            setStatus("");
            setPage(1);
          },
        }
      : null,
    q
      ? {
          key: "q",
          label: `“${q}”`,
          onClear: () => {
            setQ("");
            setPage(1);
          },
        }
      : null,
  ].filter(Boolean) as { key: string; label: string; onClear: () => void }[];

  return (
    <>
      <section className={rui.panel}>
        <div className={rui.panelHead}>
          <h2>Overview</h2>
          <p>Same-length prior window for trend</p>
        </div>
        {!s.days ? (
          <div className={rui.empty}>
            <strong>No day checklists in this range</strong>
            Widen the date range or wait for store closes.
          </div>
        ) : (
          <div className={rui.kpiGrid} aria-label="Store overview">
            <div className={rui.kpi}>
              <strong>{s.days}</strong>
              <span>Reports started</span>
            </div>
            <div className={s.avgPct >= 80 ? rui.kpiOk : s.avgPct >= 40 ? rui.kpiWarn : rui.kpiBad}>
              <strong>{s.avgPct}%</strong>
              <span>Avg completion</span>
            </div>
            <div className={rui.kpi}>
              <strong>{s.submitRate}%</strong>
              <span>Submit rate</span>
            </div>
            <div className={s.open ? rui.kpiWarn : rui.kpi}>
              <strong>{s.open}</strong>
              <span>Still open</span>
            </div>
            <div className={s.staleOpen ? rui.kpiBad : rui.kpi}>
              <strong>{s.staleOpen}</strong>
              <span>Stale / broken</span>
            </div>
            <div className={rui.kpi}>
              <strong>
                {formatStoreTrend(
                  s.byStore.find((b) => b.trendDelta != null)?.trendDelta ?? null,
                )?.replace(/^Trend\s*/, "") || "—"}
              </strong>
              <span>Trend sample</span>
            </div>
          </div>
        )}
      </section>

      <StoreContinuityPanel
        board={continuity}
        mode="store"
        activeStoreId={store}
        onSelectStore={(locationId) => {
          setStore(locationId);
          setPage(1);
        }}
        onClearStoreFilter={() => {
          setStore("");
          setPage(1);
        }}
        onOpenReport={onOpenReport}
      />

      <FilterChips
        items={chips}
        onClearAll={() => {
          setStore("");
          setPerson("");
          setStatus("");
          setQ("");
          setPage(1);
        }}
      />

      <div className={rui.split}>
        <section className={rui.panel}>
          <div className={rui.panelHead}>
            <h2>People & stores</h2>
            <span className={rui.count}>{people.length}</span>
          </div>
          <div className={rui.tableWrap}>
            <table className={rui.table}>
              <thead>
                <tr>
                  <th>Person</th>
                  <th title="Submitted / started store days">Submitted</th>
                  <th>Avg %</th>
                  <th>Open</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {!people.length ? (
                  <tr>
                    <td colSpan={5}>No people in range.</td>
                  </tr>
                ) : (
                  people.map((b) => (
                    <tr key={b.key}>
                      <td>
                        <button
                          type="button"
                          className={
                            person === b.key ? rui.linkBtnActive : rui.linkBtn
                          }
                          onClick={() => {
                            setPerson(person === b.key ? "" : b.key);
                            setPage(1);
                          }}
                        >
                          {b.label}
                        </button>
                        <small className={rui.personStores}>{[...new Set(rows.filter(r => (r.owner_user_id || r.owner_name) === b.key).map(r => { const st = stores.find(s => s.id === r.location_id); return `${r.store_code}${st?.station_name ? ` · ${st.station_name}` : ""}`; }))].join(" · ")}</small>
                      </td>
                      <td className={rui.num}>{b.submitted}/{b.days}</td>
                      <td>
                        <span className={pctClass(b.avgPct)}>{b.avgPct}%</span>
                      </td>
                      <td className={rui.num}>
                        {b.open}
                        {b.staleOpen ? (
                          <span className={rui.muted}> · {b.staleOpen} stale</span>
                        ) : null}
                      </td>
                      <td className={trendClass(b.trendDelta)}>
                        {formatStoreTrend(b.trendDelta)?.replace(/^Trend\s*/, "") ||
                          "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={rui.panel}>
          <div className={rui.panelHead}>
            <h2>By store</h2>
            <span className={rui.count}>{byStore.length}</span>
          </div>
          <div className={rui.tableWrap}>
            <table className={rui.table}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Days</th>
                  <th>Avg %</th>
                  <th>Open</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {!byStore.length ? (
                  <tr>
                    <td colSpan={5}>No stores in range.</td>
                  </tr>
                ) : (
                  byStore.map((b) => (
                    <tr key={b.key}>
                      <td>
                        <button
                          type="button"
                          className={
                            store === b.key ? rui.linkBtnActive : rui.linkBtn
                          }
                          onClick={() => {
                            setStore(store === b.key ? "" : b.key);
                            setPage(1);
                          }}
                        >
                          {b.label}
                        </button>
                      </td>
                      <td className={rui.num}>{b.days}</td>
                      <td>
                        <span className={pctClass(b.avgPct)}>{b.avgPct}%</span>
                      </td>
                      <td className={rui.num}>
                        {b.open}
                        {b.staleOpen ? (
                          <span className={rui.muted}> · {b.staleOpen} stale</span>
                        ) : null}
                      </td>
                      <td className={trendClass(b.trendDelta)}>
                        {formatStoreTrend(b.trendDelta)?.replace(/^Trend\s*/, "") ||
                          "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <details className={rui.panel}>
        <summary className={rui.panelHead}>
          <div>
            <h2>Recent reporting activity</h2>
            <p>Latest missed / open / completed</p>
          </div>
        </summary>
        {!feedItems.length ? (
          <div className={rui.empty}>No recent activity.</div>
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
      </details>

      <section className={rui.panel}>
        <div className={rui.panelHead}>
          <div>
            <h2>Day detail</h2>
            <p>{filtered.length} shown</p>
          </div>
        </div>
        <div className={rui.filterBar}>
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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
          <label className={rui.field}>
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

        <div className={`${rui.tableWrap} ${rui.tableWideWrap}`}>
          <table className={`${rui.table} ${rui.tableWide}`}>
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
                        className={
                          r.status === "open"
                            ? rui.statusOpen
                            : r.status === "submitted"
                              ? rui.statusSubmitted
                              : rui.statusCancelled
                        }
                      >
                        {storeStatusLabels[r.status]}
                      </span>
                    </td>
                    <td>
                      <div className={rui.completionCell}>
                        <span className={pctClass(r.pct)}>{r.pct}%</span>
                        <span className={rui.muted}>
                          {r.answered}/{r.total}
                        </span>
                        <span className={barClass(r.pct)} aria-hidden>
                          <i
                            className={rui.barFill}
                            style={{
                              width: `${Math.max(0, Math.min(100, r.pct))}%`,
                            }}
                          />
                        </span>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={rui.openBtnPrimary}
                        onClick={() => onOpenReport(r.id)}
                      >
                        Open
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
    <div className={rui.pager}>
      <button
        type="button"
        className={rui.pagerBtn}
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
        className={rui.pagerBtn}
        disabled={page >= pages}
        onClick={() => setPage((p) => Math.min(pages, p + 1))}
      >
        Next
      </button>
    </div>
  );
}

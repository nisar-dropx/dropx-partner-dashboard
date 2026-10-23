"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { ScrubType, ScrubTypeActivity, StationScrubActivity } from "@/lib/ops-pulse/edd-worker";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";

type Status = "none" | "missed" | "unavailable" | "done";
type Filter = "all" | "notDone" | Status;

const TYPE_LABEL: Record<ScrubType, string> = { inStation: "In-Station Scrub", onRoad: "On-Road Scrub" };
const STATUS_LABEL: Record<Status, string> = {
  none: "No scrub in 7 days",
  missed: "Not scrubbed today",
  unavailable: "Unavailable",
  done: "Scrubbed today"
};
const STATUS_CLASS: Record<Status, string> = { none: "critical", missed: "critical", unavailable: "watch", done: "good" };
/** Not scrubbed first: nothing in 7 days, then the longest gap; unreadable stations before scrubbed ones. */
const STATUS_RANK: Record<Status, number> = { none: 0, missed: 1, unavailable: 2, done: 3 };
const TZ = "Asia/Kolkata";

const dayKey = (value: Date | string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

function lastSevenDays(now: Date): string[] {
  const today = dayKey(now);
  // Noon UTC keeps the step clear of any IST date boundary.
  const base = new Date(`${today}T12:00:00Z`).getTime();
  return Array.from({ length: 7 }, (_, index) => new Date(base - index * 86_400_000).toISOString().slice(0, 10));
}

/** Whole IST calendar days between two day keys. */
function daysBetween(fromKey: string, toKey: string) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

function statusOf(activity: ScrubTypeActivity, today: string): Status {
  if (!activity.lastAt) return activity.error ? "unavailable" : "none";
  return dayKey(activity.lastAt) === today ? "done" : "missed";
}

function formatDateTime(value: string) {
  return formatOpsDateTime(value);
}

/** The exact invocation time from Amazon, e.g. "13 Oct 2026, 06:42 pm". */
function formatFullDateTime(value: string) {
  return formatOpsDateTime(value);
}

function formatDate(value: string) {
  return formatOpsDate(value);
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

function formatDay(key: string, today: string) {
  const gap = daysBetween(key, today);
  const label = formatOpsDate(key, key);
  return gap === 0 ? `Today · ${label}` : gap === 1 ? `Yesterday · ${label}` : label;
}

function relative(value: string, now: Date) {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(value)) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n\r]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type Row = {
  stationCode: string;
  name: string;
  activity: ScrubTypeActivity;
  status: Status;
  daysScrubbed: number;
  gapDays: number | null;
  fetchedAt: string | null;
};

export function ScrubReportView({ stationNames, initialType }: { stationNames: Record<string, string>; initialType: ScrubType }) {
  const [type, setType] = useState<ScrubType>(initialType);
  const [data, setData] = useState<StationScrubActivity[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openStation, setOpenStation] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async (refresh: boolean) => {
    (refresh ? setFetching : setLoading)(true);
    setError(null);
    try {
      const response = await fetch("/api/ops-pulse/edd/scrub", { method: refresh ? "POST" : "GET", headers: { Accept: "application/json" }, cache: "no-store" });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(raw.error ?? `Request failed (${response.status}).`));
      setData(Array.isArray(raw.stations) ? raw.stations : []);
      setFetchedAt(typeof raw.fetchedAt === "string" ? raw.fetchedAt : new Date().toISOString());
      setNow(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load scrub activity.");
    } finally {
      (refresh ? setFetching : setLoading)(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // "Today" and the relative times move on while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Keep the type in the URL so a shared link opens the same view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (type === "onRoad") url.searchParams.set("type", "on-road");
    else url.searchParams.delete("type");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [type]);

  const days = useMemo(() => lastSevenDays(now), [now]);
  const today = days[0];

  const rows = useMemo<Row[]>(() => {
    const inWindow = new Set(days);
    return (data ?? []).map((station) => {
      const activity = station[type];
      const status = statusOf(activity, today);
      const scrubbedDays = new Set(activity.invocations.map((item) => dayKey(item.at)).filter((key) => inWindow.has(key)));
      return {
        stationCode: station.stationCode,
        name: stationNames[station.stationCode] ?? "",
        activity,
        status,
        daysScrubbed: scrubbedDays.size,
        gapDays: activity.lastAt ? daysBetween(dayKey(activity.lastAt), today) : null,
        fetchedAt: station.fetchedAt
      };
    });
  }, [data, type, today, days, stationNames]);

  const counts = useMemo(() => {
    const result: Record<Status, number> = { none: 0, missed: 0, unavailable: 0, done: 0 };
    rows.forEach((row) => { result[row.status] += 1; });
    return result;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((row) => filter === "all" || (filter === "notDone" ? row.status === "none" || row.status === "missed" : row.status === filter))
      .filter((row) => !term || row.stationCode.toLowerCase().includes(term) || row.name.toLowerCase().includes(term))
      .sort((a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status]
        // Within a status, the oldest last scrub first.
        || (a.activity.lastAt ?? "").localeCompare(b.activity.lastAt ?? "")
        || a.stationCode.localeCompare(b.stationCode));
  }, [rows, filter, search]);

  function exportCsv() {
    const header = ["Station", "Station name", "Scrub type", "Status", "Last scrub (IST)", "Last operator", "Days scrubbed (last 7)", "All invocations (IST · operator)", "Fetched from Amazon (IST)"];
    const lines = visibleRows.map((row) => [
      row.stationCode,
      row.name,
      TYPE_LABEL[type],
      row.activity.error ? `${STATUS_LABEL[row.status]} (fetch error: ${row.activity.error})` : STATUS_LABEL[row.status],
      row.activity.lastAt ? `${formatFullDateTime(row.activity.lastAt)} (${relative(row.activity.lastAt, now)})` : "",
      row.activity.invocations[0]?.operator ?? "",
      `${row.daysScrubbed}/7`,
      row.activity.invocations.map((item) => `${formatDateTime(item.at)} · ${item.operator ?? "Unknown"}`).join(" | "),
      row.fetchedAt ? formatDateTime(row.fetchedAt) : ""
    ].map(csvCell).join(","));
    const blob = new Blob([`﻿${[header.map(csvCell).join(","), ...lines].join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `scrub-report-${type === "inStation" ? "in-station" : "on-road"}-${today}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  const notDone = counts.none + counts.missed;
  // The oldest station fetch is what the whole report can vouch for.
  const lastFetched = useMemo(() => {
    const times = (data ?? []).map((row) => row.fetchedAt).filter((value): value is string => Boolean(value)).sort();
    return times[0] ?? null;
  }, [data]);
  const openRow = openStation ? rows.find((row) => row.stationCode === openStation) ?? null : null;
  const cards: Array<{ key: Filter; label: string; value: number; note: string; tone: string }> = [
    { key: "notDone", label: "Not scrubbed today", value: notDone, note: `${counts.none} with no scrub in 7 days`, tone: "overdue" },
    { key: "done", label: "Scrubbed today", value: counts.done, note: `of ${rows.length} stations`, tone: "future" },
    { key: "none", label: "No scrub in 7 days", value: counts.none, note: "nothing in Amazon's 7-day log", tone: "dueToday" },
    { key: "unavailable", label: "Unavailable", value: counts.unavailable, note: "not fetched, or Amazon did not answer", tone: "unknown" }
  ];

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div className="segmented-control" role="tablist" aria-label="Scrub type">
            {(Object.keys(TYPE_LABEL) as ScrubType[]).map((key) => (
              <button key={key} type="button" role="tab" aria-selected={type === key} className={type === key ? "active" : ""} onClick={() => setType(key)}>
                {TYPE_LABEL[key]}
              </button>
            ))}
          </div>
          <div className="panel-head-actions">
            <span className="subtle" title="Fetched automatically every morning at 9:10 am IST">
              {lastFetched ? `Fetched from Amazon ${formatDateTime(lastFetched)} (${relative(lastFetched, now)})` : data ? "Not fetched yet" : ""} · Daily 9:10 am
            </span>
            <button type="button" className="button secondary" onClick={exportCsv} disabled={!visibleRows.length} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Download size={16} /> Export CSV
            </button>
            <button type="button" className="button" onClick={() => void load(true)} disabled={loading || fetching} title="Ask Amazon now for every station you can see" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {fetching ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />} {fetching ? "Fetching from Amazon…" : "Fetch now"}
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load scrub activity</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div>
        </section>
      ) : null}

      {data ? (
        <section className="edd-bucket-grid">
          {cards.map((card) => (
            <button
              key={card.key}
              type="button"
              className={`edd-bucket-card ${card.tone} ${filter === card.key ? "active" : ""}`}
              onClick={() => setFilter((current) => (current === card.key ? "all" : card.key))}
              aria-pressed={filter === card.key}
            >
              <span>{card.label}</span>
              <strong>{card.value.toLocaleString("en-IN")}</strong>
              <small>{card.note}</small>
            </button>
          ))}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{TYPE_LABEL[type]} by station</h3>
            <p className="subtle">Today is counted in IST. Amazon keeps the last 7 days of invocations.</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="edd-toolbar">
            <div style={{ position: "relative" }}>
              <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
              <input type="search" placeholder="Search station code or name…" value={search} onChange={(event) => setSearch(event.target.value)} style={{ paddingLeft: 30, minWidth: 240 }} />
            </div>
            {filter !== "all" ? (
              <button type="button" className="button secondary" onClick={() => setFilter("all")}>Show all stations</button>
            ) : null}
            <span className="subtle" style={{ marginLeft: "auto" }}>Showing {visibleRows.length} of {rows.length}</span>
          </div>

          {!data && loading ? (
            <p className="subtle" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <Loader2 size={16} className="edd-spin" /> Reading scrub activity from Amazon…
            </p>
          ) : null}

          {data ? (
            <div className="edd-table-wrap">
              <table className="edd-table">
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Status</th>
                    <th>Last scrub</th>
                    <th>Operator</th>
                    <th className="num">Days scrubbed (7d)</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.stationCode}>
                      <td>
                        <strong>{row.stationCode}</strong>
                        {row.name ? <small style={{ display: "block", color: "var(--muted)" }}>{row.name}</small> : null}
                      </td>
                      <td>
                        <span className={`edd-severity ${STATUS_CLASS[row.status]}`} title={row.activity.error ?? undefined}>{STATUS_LABEL[row.status]}</span>
                        {row.status === "missed" && row.gapDays ? (
                          <small style={{ display: "block", color: "var(--muted)", marginTop: 4 }}>{row.gapDays} day{row.gapDays === 1 ? "" : "s"} since last scrub{row.activity.lastAt ? ` · ${formatDate(row.activity.lastAt)}` : ""}</small>
                        ) : null}
                        {row.activity.error ? (
                          <small style={{ display: "block", color: "var(--muted)", marginTop: 4 }}>
                            {row.activity.lastAt ? `Last fetch failed, showing the saved result: ${row.activity.error}` : row.activity.error}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {row.activity.lastAt ? (
                          <>
                            <strong>{relative(row.activity.lastAt, now)}</strong>
                            <small style={{ display: "block", color: "var(--muted)" }}>{formatFullDateTime(row.activity.lastAt)}</small>
                          </>
                        ) : <span className="subtle">—</span>}
                      </td>
                      <td>{row.activity.invocations[0]?.operator ?? <span className="subtle">—</span>}</td>
                      <td className="num">{row.status === "unavailable" ? "—" : `${row.daysScrubbed}/7`}</td>
                      <td>
                        <button type="button" className="button secondary" onClick={() => setOpenStation(row.stationCode)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <CalendarDays size={14} /> View 7 days
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!visibleRows.length ? (
                    <tr><td colSpan={6} className="subtle" style={{ textAlign: "center", padding: 24 }}>No stations match.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      {openRow ? <ScrubHistoryModal row={openRow} type={type} days={days} today={today} now={now} onClose={() => setOpenStation(null)} /> : null}
    </>
  );
}

function ScrubHistoryModal({ row, type, days, today, now, onClose }: { row: Row; type: ScrubType; days: string[]; today: string; now: Date; onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byDay = useMemo(() => {
    const map = new Map<string, typeof row.activity.invocations>();
    row.activity.invocations.forEach((item) => {
      const key = dayKey(item.at);
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return map;
  }, [row]);
  const missed = days.filter((key) => !byDay.has(key)).length;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={`${row.stationCode} ${TYPE_LABEL[type]} last 7 days`} style={{ position: "relative" }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <div className="panel-head">
          <div>
            <h3>{row.stationCode} · {TYPE_LABEL[type]}</h3>
            <p className="subtle">
              {row.name ? `${row.name} · ` : ""}Last 7 days (IST)
              {row.status === "unavailable" ? "" : ` · ${7 - missed} of 7 days scrubbed${missed ? `, ${missed} missed` : ""}`}
              {row.fetchedAt ? ` · fetched ${formatDateTime(row.fetchedAt)}` : ""}
            </p>
          </div>
        </div>
        <div className="panel-body">
          {row.activity.error ? (
            <p className="subtle" style={{ color: "var(--red)", marginBottom: 12 }}>
              {row.activity.lastAt ? `The last fetch failed (${row.activity.error}). Showing the saved result.` : `No scrub activity for this station yet: ${row.activity.error}`}
            </p>
          ) : null}
          {row.activity.error && !row.activity.lastAt ? null : (
            <table className="edd-table">
              <thead><tr><th>Day</th><th>Status</th><th>Invoked at</th><th>Operator</th></tr></thead>
              <tbody>
                {days.map((key) => {
                  const items = byDay.get(key) ?? [];
                  if (!items.length) {
                    return (
                      <tr key={key}>
                        <td>{formatDay(key, today)}</td>
                        <td><span className="edd-severity critical">Not scrubbed</span></td>
                        <td className="subtle">—</td>
                        <td className="subtle">—</td>
                      </tr>
                    );
                  }
                  return items.map((item, index) => (
                    <tr key={`${key}-${item.at}-${index}`}>
                      <td>{index === 0 ? formatDay(key, today) : ""}</td>
                      <td>{index === 0 ? <span className="edd-severity good">Scrubbed{items.length > 1 ? ` ×${items.length}` : ""}</span> : null}</td>
                      <td>{formatTime(item.at)} <small style={{ color: "var(--muted)" }}>· {relative(item.at, now)}</small></td>
                      <td>{item.operator ?? <span className="subtle">Unknown</span>}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

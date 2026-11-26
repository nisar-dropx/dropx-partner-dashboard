"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Clock, Info, Loader2, Package, RefreshCw, Timer, TrendingUp, Users } from "lucide-react";
import { DsScopeFilters } from "@/app/ops-pulse/operations/ds-scope-filters";
import { emptyDsScope, scopedDsStationCodes, type DsScope } from "@/lib/ops-pulse/ds-scope";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";
import type {
  DsLiveInsight,
  DsLiveNetwork,
  DsLiveStore,
  DsLiveStoreDetail
} from "@/lib/ops-pulse/ds-live-performance";
import s from "./ds-live.module.css";

const POLL_MS = 60_000;
const PAGE_SIZE = 15;

type FilterKey = DsLiveInsight["filter"];
type SortKey =
  | "stationCode"
  | "avgPptSeconds"
  | "orderCount"
  | "unitCount"
  | "pickerCount"
  | "breachingCount"
  | "inboundOpen"
  | "feedAge";

const FILTERS: Record<FilterKey, { label: string; test: (row: DsLiveStore) => boolean }> = {
  all: { label: "All stores", test: () => true },
  slowPpi: { label: "Slow PPI", test: (row) => (row.avgPptSeconds ?? 0) >= 90 && row.orderCount > 0 },
  stale: { label: "Stale feeds", test: (row) => row.ppiStale || row.siteStale },
  acceptance: { label: "Acceptance SLA", test: (row) => row.breachingCount > 0 },
  inbound: { label: "Inbound open", test: (row) => row.inboundOpen > 0 && (row.inboundAvgPct == null || row.inboundAvgPct < 100) }
};

const TONE_ICON = { critical: AlertTriangle, watch: Clock, good: CheckCircle2, info: Info } as const;

function count(n: number) {
  return n.toLocaleString("en-IN");
}

function fmtPpt(sec: number | null | undefined) {
  if (sec == null || sec < 0) return "—";
  const value = Math.round(sec);
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function fmtClock(sec: number | null | undefined) {
  if (sec == null || sec < 0) return "—";
  const n = Math.round(sec);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

function ageLabel(iso: string | null | undefined) {
  if (!iso) return "No fetch yet";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return formatOpsDateTime(iso);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function feedAgeMs(row: DsLiveStore) {
  const iso = row.siteFetchedAt || row.ppiFetchedAt || row.lastFetchAt;
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

function sortValue(row: DsLiveStore, key: SortKey): string | number {
  switch (key) {
    case "stationCode":
      return row.stationCode;
    case "avgPptSeconds":
      return row.avgPptSeconds ?? -1;
    case "orderCount":
      return row.orderCount;
    case "unitCount":
      return row.unitCount;
    case "pickerCount":
      return row.pickerCount;
    case "breachingCount":
      return row.breachingCount;
    case "inboundOpen":
      return row.inboundOpen;
    case "feedAge":
      return feedAgeMs(row);
  }
}

export function DsLiveView({ initial }: { initial: DsLiveNetwork }) {
  const [data, setData] = useState(initial);
  const [scope, setScope] = useState<DsScope>(emptyDsScope());
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "stationCode", direction: "asc" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DsLiveStoreDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setData(initial);
  }, [initial]);

  const storeMetas = data.storeMetas?.length
    ? data.storeMetas
    : data.stores.map((row) => ({
        code: row.stationCode,
        name: row.stationName,
        city: row.city,
        state: row.state,
        regionKey: row.regionKey
      }));

  const scopedCodes = useMemo(
    () => new Set(scopedDsStationCodes(storeMetas, data.managers ?? [], scope)),
    [storeMetas, data.managers, scope]
  );

  const scopedStores = useMemo(
    () => data.stores.filter((row) => scopedCodes.has(row.stationCode)),
    [data.stores, scopedCodes]
  );

  const statusFilterKeys = useMemo(() => {
    return (Object.keys(FILTERS) as FilterKey[]).filter((key) => {
      if (key === "all") return true;
      if (key === filter) return true;
      return scopedStores.some(FILTERS[key].test);
    });
  }, [scopedStores, filter]);

  const filtered = useMemo(() => scopedStores.filter(FILTERS[filter].test), [scopedStores, filter]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sort.direction === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);
      if (typeof left === "string" && typeof right === "string") return left.localeCompare(right) * dir;
      return ((left as number) - (right as number)) * dir;
    });
    return rows;
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filter, scope, sort.key, sort.direction]);

  const loadDetail = useCallback(async (stationCode: string, businessDate: string) => {
    setDetailBusy(true);
    try {
      const res = await fetch(
        `/api/ops-pulse/ds-live?date=${encodeURIComponent(businessDate)}&station=${encodeURIComponent(stationCode)}`,
        { cache: "no-store" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String((body as { error?: string }).error ?? "Detail load failed"));
      setDetail((body as { detail: DsLiveStoreDetail }).detail);
      setError(null);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : "Detail load failed");
    } finally {
      setDetailBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected, data.businessDate);
  }, [selected, data.businessDate, loadDetail]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/ops-pulse/ds-live?date=${encodeURIComponent(data.businessDate)}`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String((body as { error?: string }).error ?? "Refresh failed"));
        if (!cancelled) {
          startTransition(() => {
            setData(body as DsLiveNetwork);
            setError(null);
          });
          if (selected) void loadDetail(selected, data.businessDate);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Refresh failed");
      }
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [data.businessDate, selected, loadDetail]);

  async function refreshNow() {
    setError(null);
    try {
      const res = await fetch(`/api/ops-pulse/ds-live?date=${encodeURIComponent(data.businessDate)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String((body as { error?: string }).error ?? "Refresh failed"));
      startTransition(() => setData(body as DsLiveNetwork));
      if (selected) void loadDetail(selected, data.businessDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    }
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "stationCode" ? "asc" : "desc" }
    );
  }

  function sortIcon(key: SortKey) {
    if (sort.key !== key) return <ArrowUpDown size={12} aria-hidden />;
    return sort.direction === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />;
  }

  const store = detail && detail.stationCode === selected
    ? detail
    : pageRows.find((row) => row.stationCode === selected) ?? sorted.find((row) => row.stationCode === selected) ?? null;
  const maxHourOrders = Math.max(1, ...((detail?.hourly ?? []).map((h) => h.orderCount)));

  return (
    <div className={s.report}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>{formatOpsDate(data.businessDate)} · store network</h2>
          <p>
            <i className={pending ? undefined : s.live} aria-hidden />
            {pending ? "Updating…" : "Live · VM feeds"}
            <span aria-hidden>·</span>
            Last network fetch {ageLabel(data.latestFetchAt)}
            <span aria-hidden>·</span>
            Board poll 60s · detail on select
          </p>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.primary} onClick={refreshNow} disabled={pending}>
            {pending ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            Refresh
          </button>
        </div>
      </div>

      {error ? <p className={s.error} role="alert"><AlertTriangle size={14} aria-hidden />{error}</p> : null}

      {/* ── Network KPI stat cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }} aria-label="Network summary">
        <div style={{ background: "linear-gradient(135deg, #fff7f2 0%, #fff 65%)", border: "1px solid #f0d4c5", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 2px 8px rgba(222,90,22,0.08)", gridColumn: "span 1" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: "#de5a16", fontSize: 11, fontWeight: 650 }}><Timer size={13} aria-hidden /> Network PPT</span>
          <strong style={{ fontSize: 28, fontWeight: 800, color: "#de5a16", letterSpacing: "-0.8px", lineHeight: 1.1 }}>{fmtPpt(data.avgPptSeconds)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>order-weighted · {count(data.storeCount)} stores</span>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--line, #e2e7ee)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11, fontWeight: 650 }}><TrendingUp size={13} aria-hidden /> Orders</span>
          <strong style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.3px" }}>{count(data.orderCount)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>completed today</span>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--line, #e2e7ee)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11, fontWeight: 650 }}><Package size={13} aria-hidden /> Units</span>
          <strong style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.3px" }}>{count(data.unitCount)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>units picked</span>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--line, #e2e7ee)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 11, fontWeight: 650 }}><Users size={13} aria-hidden /> Pickers</span>
          <strong style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.3px" }}>{count(data.pickerCount)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>with orders today</span>
        </div>
        <div style={{ background: data.stalePpiStores > 0 ? "#fffbeb" : "#fff", border: `1px solid ${data.stalePpiStores > 0 ? "#fde68a" : "var(--line, #e2e7ee)"}`, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: data.stalePpiStores > 0 ? "#d97706" : "var(--muted)", fontSize: 11, fontWeight: 650 }}><Activity size={13} aria-hidden /> Stale feeds</span>
          <strong style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.3px", color: data.stalePpiStores > 0 ? "#d97706" : undefined }}>{count(data.stalePpiStores)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>behind schedule</span>
        </div>
        <div style={{ background: data.acceptanceBreaches > 0 ? "#fff1f0" : "#fff", border: `1px solid ${data.acceptanceBreaches > 0 ? "#fecdc9" : "var(--line, #e2e7ee)"}`, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: data.acceptanceBreaches > 0 ? "#c0392b" : "var(--muted)", fontSize: 11, fontWeight: 650 }}><AlertTriangle size={13} aria-hidden /> Breaches</span>
          <strong style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.3px", color: data.acceptanceBreaches > 0 ? "#c0392b" : undefined }}>{count(data.acceptanceBreaches)}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>over SLA · {count(data.inboundOpenShipments)} inbound</span>
        </div>
      </div>

      <div className={s.scopeRow}>
        <DsScopeFilters
          stores={storeMetas}
          managers={data.managers ?? []}
          value={scope}
          onChange={setScope}
        />
      </div>

      <div className={s.filters} role="toolbar" aria-label="Store filters">
        {statusFilterKeys.map((key) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {FILTERS[key].label}
          </button>
        ))}
      </div>

      <div className={s.split}>
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>Store board</h3>
            <span>
              {sorted.length} match · page {safePage}/{pageCount}
            </span>
          </div>
          {pageRows.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className={s.board}>
                <thead>
                  <tr>
                    {(
                      [
                        ["stationCode", "Store"],
                        ["avgPptSeconds", "PPI"],
                        ["orderCount", "Orders"],
                        ["unitCount", "Units"],
                        ["pickerCount", "Pickers"],
                        ["breachingCount", "Acceptance"],
                        ["inboundOpen", "Inbound"],
                        ["feedAge", "Feed"]
                      ] as [SortKey, string][]
                    ).map(([key, label]) => (
                      <th key={key} aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className={s.sortButton} onClick={() => toggleSort(key)}>
                          {label} {sortIcon(key)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr
                      key={row.stationCode}
                      aria-selected={selected === row.stationCode}
                      onClick={() => setSelected(row.stationCode)}
                    >
                      <td>
                        <div className={s.storeCell}>
                          <strong>{row.stationCode}</strong>
                          <small>{row.stationName}{row.city ? ` · ${row.city}` : ""}</small>
                        </div>
                      </td>
                      <td>
                        <span className={`${s.badge} ${(row.avgPptSeconds ?? 0) >= 90 ? s.badgeWarn : s.badgeGood}`}>
                          {fmtPpt(row.avgPptSeconds)}
                        </span>
                      </td>
                      <td>{count(row.orderCount)}</td>
                      <td>{count(row.unitCount)}</td>
                      <td>{count(row.pickerCount)}</td>
                      <td>
                        {row.breachingCount > 0 ? (
                          <span className={`${s.badge} ${s.badgeBad}`}>{row.breachingCount} · {fmtClock(row.worstElapsedSeconds)}</span>
                        ) : row.pendingAcceptance > 0 ? (
                          <span className={`${s.badge} ${s.badgeWarn}`}>{row.pendingAcceptance} pending</span>
                        ) : (
                          <span className={`${s.badge} ${s.badgeGood}`}>{row.activeOrders ? `${row.activeOrders} active` : "Clear"}</span>
                        )}
                      </td>
                      <td>{row.inboundOpen ? `${row.inboundOpen} · ${row.inboundAvgPct == null ? "—" : `${row.inboundAvgPct}%`}` : "—"}</td>
                      <td>
                        <span className={`${s.badge} ${row.ppiStale || row.siteStale ? s.badgeWarn : s.badgeGood}`}>
                          {ageLabel(row.siteFetchedAt || row.ppiFetchedAt || row.lastFetchAt)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={s.empty}>No stores match these filters.</p>
          )}

          {sorted.length > PAGE_SIZE ? (
            <div className={s.pager}>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
              <span>Page {safePage} of {pageCount}</span>
              <button type="button" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</button>
            </div>
          ) : null}
        </section>

        <aside className={s.panel}>
          <div className={s.panelHead}>
            <h3>{selected ? `${selected} detail` : "Store detail"}</h3>
            <span>{detailBusy ? "Loading…" : store ? ageLabel(("siteFetchedAt" in store ? store.siteFetchedAt : null) || store.ppiFetchedAt) : "Select a store"}</span>
          </div>

          {selected ? (
            <div className={s.actions} style={{ marginBottom: 8 }}>
              <Link className={s.link} href={`/operations/ppi?station=${encodeURIComponent(selected)}&date=${encodeURIComponent(data.businessDate)}`}>
                Open PPI
              </Link>
              <Link className={s.link} href={`/operations/site-summary?station=${encodeURIComponent(selected)}`}>
                Open Site Summary
              </Link>
            </div>
          ) : null}

          {data.insights.length ? (
            <ul className={s.insights}>
              {data.insights.map((insight) => {
                const Icon = TONE_ICON[insight.tone];
                return (
                  <li key={insight.title} className={s[insight.tone]}>
                    <span className={s.tone} aria-hidden><Icon size={13} /></span>
                    <div>
                      <strong>{insight.title}</strong>
                      <p>{insight.detail}</p>
                    </div>
                    <button type="button" className={s.link} onClick={() => setFilter(insight.filter)}>View</button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {!selected ? (
            <p className={s.empty}>Select a store from the board.</p>
          ) : detailBusy && !detail ? (
            <p className={s.empty}><Loader2 size={14} className="spin" aria-hidden /> Loading store detail…</p>
          ) : detail && detail.stationCode === selected ? (
            <div className={s.detail}>
              <div className={s.detailSection}>
                <h4>Hourly orders</h4>
                {detail.hourly.length ? (
                  <div className={s.chart} aria-label="Hourly order chart">
                    {detail.hourly.map((h) => (
                      <div key={h.hour} className={s.bar} title={`${String(h.hour).padStart(2, "0")}:00 · ${h.orderCount} orders · PPI ${fmtPpt(h.avgPptSeconds)}`}>
                        <div className={s.plot}>
                          <span style={{ height: `${Math.max(4, (h.orderCount / maxHourOrders) * 100)}%` }} />
                        </div>
                        <small>{String(h.hour).padStart(2, "0")}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={s.empty}>No hourly PPI yet for this store today.</p>
                )}
              </div>

              <div className={s.detailSection}>
                <h4>Pickers</h4>
                {detail.pickers.length ? (
                  <table className={s.miniTable}>
                    <thead><tr><th>Associate</th><th>Orders</th><th>Units</th><th>PPI</th></tr></thead>
                    <tbody>
                      {detail.pickers.slice(0, 12).map((p) => (
                        <tr key={p.username}>
                          <td>{p.username}</td>
                          <td>{count(p.orderCount)}</td>
                          <td>{count(p.unitCount)}</td>
                          <td>{fmtPpt(p.avgPptSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className={s.empty}>No picker rows yet.</p>
                )}
              </div>

              <div className={s.detailSection}>
                <h4>Site Summary · pending acceptance</h4>
                {detail.siteOrders.filter((o) => {
                  const status = String(o.status ?? "").toUpperCase();
                  return status === "OFFERED" || status === "UNASSIGNED";
                }).length ? (
                  <table className={s.miniTable}>
                    <thead><tr><th>OID</th><th>Associate</th><th>Items</th><th>Clock</th></tr></thead>
                    <tbody>
                      {detail.siteOrders
                        .filter((o) => {
                          const status = String(o.status ?? "").toUpperCase();
                          return status === "OFFERED" || status === "UNASSIGNED";
                        })
                        .map((o) => (
                        <tr key={o.oid}>
                          <td>{o.oid}</td>
                          <td>{o.picker || "—"}</td>
                          <td>{count(o.items)}</td>
                          <td>
                            <span className={`${s.badge} ${o.elapsedSeconds >= detail.slaSeconds ? s.badgeBad : s.badgeGood}`}>
                              {fmtClock(o.elapsedSeconds)} / {fmtClock(o.acceptanceTargetSeconds ?? detail.slaSeconds)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className={s.empty}>
                    {detail.siteFetchedAt ? "No pending acceptance orders." : "Site Summary not ingested yet for this store."}
                  </p>
                )}
              </div>

              <div className={s.detailSection}>
                <h4>Inbound</h4>
                {detail.inbound.length ? (
                  <table className={s.miniTable}>
                    <thead><tr><th>Shipment</th><th>Status</th><th>%</th><th>Pending</th></tr></thead>
                    <tbody>
                      {detail.inbound.map((ship) => (
                        <tr key={ship.id}>
                          <td>{ship.amazonShipmentRefId}</td>
                          <td>{ship.status || "—"}</td>
                          <td>{ship.pctCompletion == null ? "—" : `${ship.pctCompletion}%`}</td>
                          <td>{count(ship.reconcilePending)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className={s.empty}>No open inbound shipments.</p>
                )}
              </div>

              <div className={s.detailSection}>
                <h4>Recent completed orders</h4>
                {detail.recentOrders.length ? (
                  <table className={s.miniTable}>
                    <thead><tr><th>Completed</th><th>Picker</th><th>Units</th><th>PPT</th></tr></thead>
                    <tbody>
                      {detail.recentOrders.slice(0, 10).map((o) => (
                        <tr key={o.procurementListId}>
                          <td>{formatOpsDateTime(o.completedAt)}</td>
                          <td>{o.username}</td>
                          <td>{count(o.unitCount)}</td>
                          <td>{fmtPpt(o.pptSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className={s.empty}>No order-level PPI rows yet.</p>
                )}
              </div>
            </div>
          ) : (
            <p className={s.empty}>Unable to load this store’s detail.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Coffee, Loader2, Package, RefreshCw, ShoppingCart, Timer, Users, Zap } from "lucide-react";
import type { DsLiveNetwork, DsLiveSiteOrder, DsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import s from "./ds-ops.module.css";

const POLL_MS = 10_000;

function count(n: number) {
  return n.toLocaleString("en-IN");
}

function fmtClock(sec: number | null | undefined) {
  if (sec == null || sec < 0) return "—";
  const n = Math.round(sec);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

function actualTarget(actual: number | null | undefined, target: number | null | undefined) {
  if (actual == null && target == null) return { text: "—", over: false };
  const over = actual != null && target != null && actual > target;
  return {
    text: `${fmtClock(actual)} / ${fmtClock(target)}`,
    over
  };
}

function ageLabel(iso: string | null | undefined) {
  if (!iso) return "No fetch yet";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function istPartsFromMs(ms: number) {
  const ist = new Date(ms + 5.5 * 3600 * 1000);
  return {
    date: ist.toISOString().slice(0, 10),
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes()
  };
}

/** Advance running clocks since the last VM poll so DropX tracks Amazon between fetches. */
function liveOrders(orders: DsLiveSiteOrder[], fetchedAt: string | null | undefined, nowMs: number, live: boolean): DsLiveSiteOrder[] {
  if (!live) return orders;
  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const dt = Number.isFinite(fetchedMs) ? Math.max(0, (nowMs - fetchedMs) / 1000) : 0;
  if (dt < 0.5) return orders;
  return orders.map((o) => {
    const status = String(o.status ?? "").toUpperCase();
    const packing = (o.packRackSeconds != null && o.packRackSeconds > 0)
      || /SLAM|PACK|STAGE/.test(status);
    if (packing) {
      return {
        ...o,
        packRackSeconds: (o.packRackSeconds ?? 0) + dt,
        totalSeconds: o.totalSeconds != null ? o.totalSeconds + dt : null
      };
    }
    if (o.pickingSeconds != null) {
      return {
        ...o,
        pickingSeconds: o.pickingSeconds + dt,
        totalSeconds: o.totalSeconds != null ? o.totalSeconds + dt : null
      };
    }
    return {
      ...o,
      acceptanceSeconds: o.acceptanceSeconds != null ? o.acceptanceSeconds + dt : null,
      elapsedSeconds: (o.elapsedSeconds ?? 0) + dt,
      totalSeconds: o.totalSeconds != null ? o.totalSeconds + dt : null
    };
  });
}

export function DsSiteSummaryView({
  network,
  initialDetail,
  initialStation,
  initialAsOf
}: {
  network: DsLiveNetwork;
  initialDetail: DsLiveStoreDetail | null;
  initialStation: string;
  initialAsOf?: string | null;
}) {
  const router = useRouter();
  const isLive = network.mode !== "historical" && !initialAsOf;
  const seedParts = initialAsOf
    ? istPartsFromMs(Date.parse(initialAsOf) || Date.now())
    : istPartsFromMs(Date.now());
  const [station, setStation] = useState(initialStation || network.stores[0]?.stationCode || "");
  const [detail, setDetail] = useState(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [histDate, setHistDate] = useState(seedParts.date);
  const [histTime, setHistTime] = useState(
    `${String(seedParts.hour).padStart(2, "0")}:${String(seedParts.minute).padStart(2, "0")}`
  );

  function asOfParam() {
    if (isLive) return "";
    return `${histDate}T${histTime}`;
  }

  async function loadStation(next: string, asOfOverride?: string | null) {
    setStation(next);
    setError(null);
    setPending(true);
    try {
      const asOf = asOfOverride === undefined ? asOfParam() : (asOfOverride ?? "");
      const qs = new URLSearchParams({ date: network.businessDate, station: next });
      if (asOf) qs.set("asOf", asOf);
      const res = await fetch(`/api/ops-pulse/ds-live?${qs.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String((body as { error?: string }).error ?? "Site Summary load failed"));
      setDetail((body as { detail: DsLiveStoreDetail }).detail);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : "Site Summary load failed");
    } finally {
      setPending(false);
    }
  }

  function goLive() {
    const qs = new URLSearchParams();
    if (station) qs.set("station", station);
    router.push(`/operations/site-summary${qs.toString() ? `?${qs}` : ""}`);
  }

  function applyHistory() {
    const qs = new URLSearchParams();
    if (station) qs.set("station", station);
    qs.set("date", histDate);
    qs.set("asOf", `${histDate}T${histTime}`);
    router.push(`/operations/site-summary?${qs.toString()}`);
  }

  useEffect(() => {
    if (!station || !isLive) return;
    let cancelled = false;
    let inFlight = false;
    const id = window.setInterval(() => {
      if (cancelled || inFlight) return;
      inFlight = true;
      void loadStation(station, "").finally(() => {
        inFlight = false;
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station, network.businessDate, isLive]);

  useEffect(() => {
    if (!isLive) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive]);

  const associates = detail?.associates ?? {
    waitingForOrders: 0,
    onBreak: 0,
    offered: 0,
    picking: 0,
    packingRacking: 0,
    otherActivities: 0,
    total: 0
  };
  const pendingAcceptance = detail?.pendingAcceptance ?? 0;
  const orders = liveOrders(detail?.siteOrders ?? [], detail?.siteFetchedAt, nowMs, isLive);

  return (
    <div className={s.report}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Site Summary</h2>
          <p>
            <i className={pending || !isLive ? undefined : s.live} aria-hidden />
            {pending ? "Updating…" : isLive ? "Live" : `As of ${histDate} ${histTime} IST`}
            <span aria-hidden>·</span>
            Feed {ageLabel(detail?.siteFetchedAt)}
            {isLive ? (
              <>
                <span aria-hidden>·</span>
                Poll 10s
              </>
            ) : null}
          </p>
        </div>
        <div className={s.actions}>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Store
            <select
              value={station}
              onChange={(e) => void loadStation(e.target.value)}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            >
              {network.stores.map((row) => (
                <option key={row.stationCode} value={row.stationCode}>
                  {row.stationCode} · {row.stationName}
                </option>
              ))}
            </select>
          </label>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Date
            <input
              type="date"
              value={histDate}
              onChange={(e) => setHistDate(e.target.value)}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            />
          </label>
          <label className={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Time IST
            <input
              type="time"
              value={histTime}
              onChange={(e) => setHistTime(e.target.value)}
              style={{ height: 36, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit" }}
            />
          </label>
          <button type="button" className={s.primary} onClick={applyHistory} disabled={pending || !station}>
            View history
          </button>
          {!isLive ? (
            <button type="button" className={s.primary} onClick={goLive} disabled={pending}>
              Back to live
            </button>
          ) : (
            <button type="button" className={s.primary} onClick={() => void loadStation(station, "")} disabled={pending || !station}>
              {pending ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
              Refresh
            </button>
          )}
        </div>
      </div>

      {error ? <p className={s.error} role="alert"><AlertTriangle size={14} aria-hidden />{error}</p> : null}

      {/* ── Associate status cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }} aria-label="Associate status">
        {(
          [
            { label: "Waiting", value: associates.waitingForOrders, icon: <Timer size={16} />, color: "#667085", bg: "#f8fafc" },
            { label: "On Break", value: associates.onBreak, icon: <Coffee size={16} />, color: "#667085", bg: "#f8fafc" },
            { label: "Offered", value: associates.offered, icon: <Zap size={16} />, color: "#d97706", bg: "#fffbeb" },
            { label: "Picking", value: associates.picking, icon: <ShoppingCart size={16} />, color: "#2563eb", bg: "#eff6ff" },
            { label: "Packing", value: associates.packingRacking, icon: <Package size={16} />, color: "#7c3aed", bg: "#f5f3ff" },
            { label: "Other", value: associates.otherActivities, icon: <Users size={16} />, color: "#667085", bg: "#f8fafc" },
            { label: "Total", value: associates.total, icon: <Users size={16} />, color: "#de5a16", bg: "#fff7f2", hero: true }
          ]
        ).map(({ label, value, icon, color, bg, hero }) => (
          <div key={label} style={{ background: bg, border: `1px solid ${hero ? "#f0d4c5" : "var(--line, #e2e7ee)"}`, borderRadius: 14, padding: hero ? "14px 16px" : "12px 14px", display: "flex", flexDirection: "column", gap: 4, boxShadow: hero ? "0 2px 8px rgba(222,90,22,0.08)" : "0 1px 3px rgba(16,24,40,0.05)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5, color, fontSize: 11, fontWeight: 650 }}>
              {icon} {label}
            </span>
            <strong style={{ fontSize: hero ? 28 : 20, fontWeight: 800, color: hero ? "#de5a16" : "var(--ink)", letterSpacing: hero ? "-0.8px" : "-0.3px", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
              {count(value)}
            </strong>
          </div>
        ))}
      </div>

      {pendingAcceptance > 0 ? (
        <p className={s.error} role="status">
          <AlertTriangle size={14} aria-hidden />
          <strong>Attention!</strong> {pendingAcceptance} order{pendingAcceptance === 1 ? "" : "s"} pending acceptance — ensure pickers are available.
        </p>
      ) : null}

      {/* ── Active orders ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Active orders</h3>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className={`${s.badge} ${s.badgeGood}`}>{orders.filter(o => !actualTarget(o.totalSeconds, o.totalTargetSeconds).over).length} on time</span>
            {orders.filter(o => actualTarget(o.totalSeconds, o.totalTargetSeconds).over).length > 0 && (
              <span className={`${s.badge} ${s.badgeBad}`}>{orders.filter(o => actualTarget(o.totalSeconds, o.totalTargetSeconds).over).length} over SLA</span>
            )}
            <span>SLA {fmtClock(detail?.slaSeconds ?? 15)}</span>
          </span>
        </div>
        {orders.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={s.board}>
              <thead>
                <tr>
                  <th>OID</th>
                  <th>Items</th>
                  <th>% Done</th>
                  <th>Associate</th>
                  <th>Acceptance</th>
                  <th>Picking</th>
                  <th>Pack &amp; Rack</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const accept = actualTarget(o.acceptanceSeconds ?? o.elapsedSeconds, o.acceptanceTargetSeconds ?? detail?.slaSeconds ?? 15);
                  const picking = actualTarget(o.pickingSeconds, o.pickingTargetSeconds);
                  const pack = actualTarget(o.packRackSeconds, o.packRackTargetSeconds);
                  const total = actualTarget(o.totalSeconds, o.totalTargetSeconds);
                  return (
                    <tr key={o.oid}>
                      <td><strong style={{ color: "#2563eb" }}>{o.oid}</strong></td>
                      <td>{count(o.items)}</td>
                      <td>
                        {o.pctComplete == null ? "—" : (
                          <span>
                            <span className={s.badge}>{Math.round(o.pctComplete)}%</span>
                            <span style={{ display: "block", width: 48, height: 4, background: "#f3f4f6", borderRadius: 2, marginTop: 3 }}>
                              <span style={{ display: "block", width: `${Math.round(o.pctComplete)}%`, height: "100%", background: "#2563eb", borderRadius: 2 }} />
                            </span>
                          </span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{o.picker || <span style={{ color: "var(--muted)" }}>Unassigned</span>}</td>
                      <td><span className={`${s.badge} ${accept.over ? s.badgeBad : s.badgeGood}`}>{accept.text}</span></td>
                      <td><span className={`${s.badge} ${picking.over ? s.badgeBad : picking.text === "—" ? "" : s.badgeGood}`}>{picking.text}</span></td>
                      <td><span className={`${s.badge} ${pack.over ? s.badgeBad : pack.text === "—" ? "" : ""}`}>{pack.text}</span></td>
                      <td><span className={`${s.badge} ${total.over ? s.badgeBad : total.text === "—" ? "" : s.badgeGood}`}>{total.text}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>
            <ShoppingCart size={28} style={{ opacity: 0.25 }} aria-hidden />
            <span>
              {detail?.siteFetchedAt
                ? "No active orders in this snapshot."
                : isLive
                  ? "Site Summary not ingested yet — keep the VM monitor running."
                  : "No history found at or before this time."}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}

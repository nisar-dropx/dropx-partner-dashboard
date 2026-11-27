"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RefreshCw, ShoppingCart } from "lucide-react";
import type { DsLiveNetwork, DsLiveSiteOrder, DsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import s from "./ds-ops.module.css";
import ss from "./site-summary.module.css";

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

      {/* ── Associate status banner (matches Amazon Site Summary header) ── */}
      <div className={ss.assocBanner}>
        {(
          [
            { label: "Waiting for Orders", value: associates.waitingForOrders },
            { label: "On Break",            value: associates.onBreak },
            { label: "Offered",             value: associates.offered },
            { label: "Picking",             value: associates.picking },
            { label: "Packing & Racking",   value: associates.packingRacking },
            { label: "Other Activities",    value: associates.otherActivities },
            { label: "Total Associates",    value: associates.total }
          ]
        ).map(({ label, value }) => (
          <div key={label} className={ss.assocCell}>
            <span className={ss.assocLabel}>{label}</span>
            <strong className={ss.assocValue}>{count(value)}</strong>
          </div>
        ))}
      </div>

      {pendingAcceptance > 0 ? (
        <div className={ss.alertBanner} role="status">
          <AlertTriangle size={14} aria-hidden />
          Attention! You have {pendingAcceptance} order{pendingAcceptance === 1 ? "" : "s"} pending acceptance. Please ensure pickers are available to accept new orders.
        </div>
      ) : null}

      {/* ── Active orders table (matches Amazon layout exactly) ── */}
      <section className={ss.ordersPanel}>
        <div className={ss.ordersPanelHead}>
          <span>OID</span>
          <span>Items</span>
          <span>% Picking Completed</span>
          <span>Assigned Associate</span>
          <span>Acceptance Time</span>
          <span>Picking Time</span>
          <span>Pack &amp; Rack Time</span>
          <span>Total Time</span>
        </div>
        {orders.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className={ss.ordersTable}>
              <thead>
                <tr>
                  <th>OID</th>
                  <th>Items</th>
                  <th>% Picking Completed</th>
                  <th>Assigned Associate</th>
                  <th>Acceptance Time</th>
                  <th>Picking Time</th>
                  <th>Pack &amp; Rack Time</th>
                  <th>Total Time</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => {
                  const accept = actualTarget(o.acceptanceSeconds ?? o.elapsedSeconds, o.acceptanceTargetSeconds ?? detail?.slaSeconds ?? 15);
                  const picking = actualTarget(o.pickingSeconds, o.pickingTargetSeconds);
                  const pack = actualTarget(o.packRackSeconds, o.packRackTargetSeconds);
                  const total = actualTarget(o.totalSeconds, o.totalTargetSeconds);
                  return (
                    <tr key={o.oid} className={i % 2 === 1 ? ss.rowAlt : ""}>
                      <td><span className={ss.oidLink}>{o.oid}</span></td>
                      <td>{count(o.items)}</td>
                      <td>{o.pctComplete == null ? "—" : `${Math.round(o.pctComplete)}%`}</td>
                      <td className={ss.associate}>{o.picker || <span className={ss.noAssoc}>No Idle Associates</span>}</td>
                      <td><span className={accept.over ? ss.timeOver : ss.timeOk}>{accept.text}</span></td>
                      <td><span className={picking.over ? ss.timeOver : ""}>{picking.text}</span></td>
                      <td>{pack.text}</td>
                      <td><span className={total.over ? ss.timeOver : ""}>{total.text}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={ss.empty}>
            <ShoppingCart size={28} style={{ opacity: 0.25 }} aria-hidden />
            <span>
              {detail?.siteFetchedAt
                ? "No active orders in this snapshot."
                : isLive
                  ? "Site Summary not ingested yet — keep the VM monitor running."
                  : "No history found at or before this time."}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

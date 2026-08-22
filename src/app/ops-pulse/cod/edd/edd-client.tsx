"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddBucketKey, EddPackage, EddStationPayload } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "./page";

const BUCKET_META: Record<EddBucketKey, { label: string; hint: string }> = {
  overdue: { label: "Overdue", hint: "EAD already passed — highest priority" },
  dueToday: { label: "Due today", hint: "Must deliver today" },
  dueTomorrow: { label: "Due tomorrow", hint: "Stage for tomorrow's routes" },
  future: { label: "Future", hint: "EAD more than a day out" },
  unknown: { label: "No EAD found", hint: "Missing date fields from Amazon" }
};

const BUCKET_ORDER: EddBucketKey[] = ["overdue", "dueToday", "dueTomorrow", "future", "unknown"];

function formatMinutes(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${rest}m`;
}

function formatFetchedAt(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function fetchEddClient(stationCode: string): Promise<EddStationPayload> {
  const url = new URL("/api/ops-pulse/edd", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Unable to load EDD data (${response.status}).`));
  }
  return payload as unknown as EddStationPayload;
}

export function EddClient({ stations, initialStation }: { stations: EddStationOption[]; initialStation: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  const [stationCode, setStationCode] = useState(initialStation);
  const [payload, setPayload] = useState<EddStationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeBucket, setActiveBucket] = useState<EddBucketKey | null>(null);
  const [search, setSearch] = useState("");
  const [requestToken, setRequestToken] = useState(0);

  useEffect(() => {
    if (!stationCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchEddClient(stationCode)
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
        setActiveBucket(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "Unable to load the EDD dashboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationCode, requestToken]);

  const today = todayIstYmd();
  const tomorrow = addDaysYmd(today, 1);

  const filteredPackages = useMemo(() => {
    const rows = payload?.packages ?? [];
    const term = search.trim().toLowerCase();
    return rows.filter((pkg) => {
      if (activeBucket && pkg.bucket !== activeBucket) return false;
      if (!term) return true;
      return [pkg.trackingId, pkg.lastScanBy, pkg.city, pkg.orderingOrderId, pkg.state]
        .some((field) => String(field ?? "").toLowerCase().includes(term));
    });
  }, [payload, activeBucket, search]);

  const sortedPackages = useMemo(() => {
    return [...filteredPackages].sort((a, b) => {
      const aKey = a.ead ?? "9999-99-99";
      const bKey = b.ead ?? "9999-99-99";
      if (aKey !== bKey) return aKey.localeCompare(bKey);
      return b.minutesInState - a.minutesInState;
    });
  }, [filteredPackages]);

  function selectStation(nextCode: string) {
    setStationCode(nextCode);
    startTransition(() => {
      router.replace(`${pathname}?station=${encodeURIComponent(nextCode)}`);
    });
  }

  const maxDayCount = Math.max(1, ...(payload?.byDate ?? []).map((row) => row.count));

  return (
    <>
      <section className="panel">
        <div className="panel-body edd-toolbar">
          <select
            value={stationCode}
            onChange={(event) => selectStation(event.target.value)}
            style={{ minHeight: "var(--control-height)", padding: "0 10px", borderRadius: "var(--radius)", border: "1px solid var(--line)" }}
          >
            {stations.map((station) => (
              <option key={station.code} value={station.code}>
                {station.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="button secondary"
            onClick={() => setRequestToken((value) => value + 1)}
            disabled={loading}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {loading ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
            {loading ? "Loading live…" : "Refresh live"}
          </button>

          <span className="subtle" style={{ marginLeft: "auto" }}>
            {payload
              ? `${payload.totalCount.toLocaleString("en-IN")} live TIDs · ${formatCiaDisplayDate(payload.window.from)} - ${formatCiaDisplayDate(payload.window.to)} · fetched ${formatFetchedAt(payload.fetchedAt)}`
              : " "}
          </span>
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load {stationCode || "this station"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      {loading && !payload ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="edd-spin" />
            <span className="subtle">Loading live EDD backlog for {stationCode}…</span>
          </div>
        </section>
      ) : null}

      {payload ? (
        <>
          <section className="edd-bucket-grid">
            {BUCKET_ORDER.map((bucket) => {
              const meta = BUCKET_META[bucket];
              const count = payload.buckets[bucket] ?? 0;
              const isActive = activeBucket === bucket;
              return (
                <button
                  key={bucket}
                  type="button"
                  className={`edd-bucket-card ${bucket}${isActive ? " active" : ""}`}
                  onClick={() => setActiveBucket(isActive ? null : bucket)}
                >
                  <span>{meta.label}</span>
                  <strong>{count.toLocaleString("en-IN")}</strong>
                  <small>{meta.hint}</small>
                </button>
              );
            })}
          </section>

          {payload.byDate.length ? (
            <section className="panel">
              <div className="panel-head">
                <h3>Day-level EAD trend</h3>
              </div>
              <div className="panel-body">
                <div className="edd-daybar-track">
                  {payload.byDate.map((row) => (
                    <div key={row.date} className="edd-daybar-col">
                      <span className="edd-daybar-count">{row.count}</span>
                      <div
                        className={`edd-daybar-bar${row.date < today ? " overdue" : row.date === today ? " today" : ""}`}
                        style={{ height: `${Math.max(4, Math.round((row.count / maxDayCount) * 90))}px` }}
                      />
                      <span className="edd-daybar-date">{formatCiaDisplayDate(row.date).replace(/, \d{4}$/, "")}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h3>
                Live tracking IDs
                {activeBucket ? ` · ${BUCKET_META[activeBucket].label}` : ""}
              </h3>
            </div>
            <div className="panel-body">
              <div className="edd-toolbar">
                <div style={{ position: "relative" }}>
                  <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                  <input
                    type="search"
                    placeholder="Search tracking ID, driver, city, order ID…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    style={{ paddingLeft: 30 }}
                  />
                </div>
                {activeBucket ? (
                  <button type="button" className="button secondary" onClick={() => setActiveBucket(null)}>
                    Clear bucket filter
                  </button>
                ) : null}
                <span className="subtle" style={{ marginLeft: "auto" }}>
                  Showing {sortedPackages.length.toLocaleString("en-IN")} of {payload.totalCount.toLocaleString("en-IN")}
                </span>
              </div>

              <div className="edd-table-wrap">
                <table className="edd-table">
                  <thead>
                    <tr>
                      <th>Tracking ID</th>
                      <th>EAD</th>
                      <th>Bucket</th>
                      <th>State</th>
                      <th>Driver</th>
                      <th>Payment</th>
                      <th>City</th>
                      <th>Age in state</th>
                      <th>Order ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPackages.slice(0, 500).map((pkg: EddPackage) => (
                      <tr key={pkg.trackingId}>
                        <td>{pkg.trackingId}</td>
                        <td>
                          {pkg.ead
                            ? `${formatCiaDisplayDate(pkg.ead)}${pkg.ead === today ? " (today)" : pkg.ead === tomorrow ? " (tomorrow)" : ""}`
                            : "—"}
                        </td>
                        <td>
                          <span className={`edd-pill ${pkg.bucket}`}>{BUCKET_META[pkg.bucket].label}</span>
                        </td>
                        <td>{pkg.state || "—"}</td>
                        <td>{pkg.lastScanBy || pkg.driverId || "—"}</td>
                        <td>{pkg.paymentMethod || "—"}</td>
                        <td>{pkg.city || "—"}</td>
                        <td>{formatMinutes(pkg.minutesInState)}</td>
                        <td>{pkg.orderingOrderId || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sortedPackages.length > 500 ? (
                  <p className="subtle" style={{ marginTop: 10 }}>
                    Showing the first 500 of {sortedPackages.length.toLocaleString("en-IN")} matching rows. Narrow with the search box or a bucket filter to see the rest.
                  </p>
                ) : null}
                {!sortedPackages.length ? <p className="subtle" style={{ marginTop: 10 }}>No tracking IDs match this filter.</p> : null}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

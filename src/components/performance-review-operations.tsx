
"use client";

import { useEffect, useState } from "react";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import { reviewClock, type ReviewEddTimeline, type UtrDiscipline, type ReviewEddRefreshSource } from "@/lib/ops-pulse/review-operations";
import { dashboardDateInputValue, formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { UtrAttendanceDrilldown, UtrRepeatSummary } from "@/components/review-attendance-history";

const count = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-IN");

export function PerformanceEddClearanceCard({ data, stationCode }: { data: { timeline: ReviewEddTimeline; error: string | null; routeError?: string | null; collection?: ReviewEddRefreshSource[] }; stationCode?: string }) {
  const [liveData, setLiveData] = useState(data);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const day = data.timeline.day;
  useEffect(() => { setLiveData(data); setRefreshError(null); }, [data]);
  useEffect(() => {
    if (!stationCode || day !== dashboardDateInputValue()) return;
    let stopped = false, inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (document.hidden || inFlight || stopped) return;
      inFlight = true;
      const requestController = new AbortController();
      controller = requestController;
      const timeout = setTimeout(() => requestController.abort(), 45_000);
      try {
        const response = await fetch("/api/ops-pulse/performance/edd-history?" + new URLSearchParams({ station: stationCode, date: day }), {
          cache: "no-store", signal: requestController.signal
        });
        const result = await response.json();
        if (!response.ok || !result.timeline || result.timeline.day !== day) throw Error("refresh");
        if (!stopped) { setLiveData(result); setRefreshError(null); }
      } catch { if (!stopped) setRefreshError("Refresh unavailable · showing the last recorded observation."); }
      finally { clearTimeout(timeout); inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { stopped = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [stationCode, day]);
  const { timeline: t, error, routeError, collection = [] } = liveData;
  const [view, setView] = useState<"edd" | "route">("edd");
  const route = t.routeLatest;
  return <ReviewDetails className={`performance-fact-card review-operation-card ${t.latestFresh && t.latest?.counts.todayAtStation ? "late" : ""}`} name="performance-review-fact">
    <summary aria-label="EDD and out-on-road movement — view half-hour history">
      <span>EDD / OUT-ON-ROAD</span>
      <strong>{error ? "Data unavailable" : t.summary}</strong>
      <small>{t.latest ? `Observed ${reviewClock(t.latest.observedAt)} IST${t.current ? "" : " · capture gap"}` : "06:00–EOD history"}</small>
    </summary>
    <div className="review-operation-popover">
      <ReviewDetailsClose label="Close delivery movement history"/>
      <header><div><b>Delivery movement · {formatDashboardDate(t.day)}</b><p>Half-hour checkpoints · all times IST</p></div><span className="review-operation-tag">Automatic</span></header>
      {error ? <p role="alert">{error}</p> : null}
      {refreshError ? <p role="status" className="review-operation-note">{refreshError}</p> : null}
      <p className="review-operation-note">Source refresh target: every 15 minutes · checkpoints: 06:00, 06:30, then every half hour. Temporary source failures retry automatically. Source times can differ between stations; these are observed snapshots, not simultaneous scans.</p>
      {collection.some(source => source.last_error) ? <p role="status" className="review-operation-note">Retry queued: {collection.filter(source => source.last_error).map(source => `${source.source === "stock" ? "Station stock" : "Delivery outcomes"} (${source.last_error === "login_busy" ? "shared login busy" : source.last_error === "upstream_502" ? "Amazon proxy unavailable" : source.last_error === "timeout" ? "source timed out" : "fresh source unavailable"})`).join(" · ")}. No missing value is treated as zero.</p> : null}
      <div className="review-edd-view-switch" role="tablist" aria-label="Delivery movement view">
        <button type="button" role="tab" aria-selected={view === "edd"} onClick={() => setView("edd")}>EDD due today</button>
        <button type="button" role="tab" aria-selected={view === "route"} onClick={() => setView("route")}>All out on road</button>
      </div>
      {view === "edd" ? <>
        {!t.latestFresh && t.lastConfirmed ? <div className="review-operation-summary" role="status">
          <span>Last valid observation — {reviewClock(t.lastConfirmed.observedAt)} IST. Not current.</span>
          <span>Observed EDD <b>{count(t.lastConfirmed.counts.todayTotal - t.lastConfirmed.counts.todayHfr - (t.lastConfirmed.counts.todayHcr ?? 0))}</b></span>
          <span>Pending <b>{count(t.lastConfirmed.counts.todayAtStation)}</b></span>
          <span>On road <b>{count(t.lastConfirmed.counts.todayOnRoad)}</b></span>
          <span>Delivered <b>{count(t.lastConfirmed.counts.todayDelivered)}</b></span>
        </div> : null}
        <div className="review-operation-summary"><span>Day-start EDD <b>{count(t.dayStart)}</b></span><span>Confirmed pending <b>{count(t.latestFresh ? t.latest?.counts.todayAtStation : null)}</b></span><span>Awaiting checks <b>{count(t.latestFresh ? t.latest?.counts.todayUnverified : null)}</b></span></div>
        <p className="review-operation-note">EDD includes only shipments due on the selected date. {t.baselineAt ? `The day-start cohort is frozen at the first valid morning observation (${reviewClock(t.baselineAt)}).` : "A valid 06:00 baseline was not recorded, so no later total is presented as the day-start EDD."} Prior-day attempt cohorts are excluded. Observed INDUCTED/RECEIVED includes returns and unchecked parcels; only confirmed first-dispatch pending is used for clearance.</p>
        <div className="review-operation-table" role="region" aria-label="EDD half-hour history, scroll for all times and columns" tabIndex={0}>
          <table><thead><tr><th>Checkpoint</th><th>Day-start EDD</th><th>Observed EDD</th><th>Confirmed pending</th><th>Observed INDUCTED / RECEIVED</th><th>On road</th><th>Delivered</th><th>Attempted</th><th>Unchecked / other</th><th>Observation / source times</th></tr></thead>
            <tbody>{t.rows.map(row => { const c = row.state === "Recorded" && row.point?.counts.hasSnapshot ? row.point.counts : null; return <tr key={row.label} className={c ? "" : "review-operation-muted"}>
              <th scope="row">{row.label}</th><td>{c ? count(row.dayStart) : "—"}</td><td>{c ? count(c.todayTotal - c.todayHfr - (c.todayHcr ?? 0)) : "—"}</td>
              <td className={c?.todayAtStation ? "review-operation-pending" : ""}>{c && c.todayUnverified > 0 ? `${count(c.todayAtStation)} confirmed` : count(c?.todayAtStation)}</td><td>{count(c?.todayObservedAtStation)}</td><td>{count(c?.todayOnRoad)}</td><td>{count(c?.todayDelivered)}</td><td>{count(c?.todayAttempted)}</td>
              <td>{c ? count(c.todayUnverified + c.todayOther) : "—"}</td><td>{row.point ? <>{reviewClock(row.point.observedAt)}<small>{row.state}</small><small>Stock {reviewClock(row.point.backlogAt)} · outcomes {reviewClock(row.point.performanceAt)}</small></> : row.state}</td>
            </tr>; })}</tbody></table>
        </div>
        <p className="review-operation-note">A missing or stale checkpoint stays marked; a later snapshot never fills it. “Observed clear at” is the first observation in a continuous run of valid checks with no pending, unchecked or undated TIDs, not an exact dispatch scan time.</p>
        {t.latest ? <p className="review-operation-note">Latest EDD sources: stock {formatDashboardDateTime(t.latest.backlogAt)} · outcomes {formatDashboardDateTime(t.latest.performanceAt)} IST · {count(t.latest.counts.missingDate)} missing EDD dates · {count(t.latest.counts.todayHfr)} prior-day HFR · {count(t.latest.counts.todayHcr)} prior-day HCR.</p> : null}
      </> : <>
        {routeError ? <p role="alert" className="review-operation-note">{routeError}</p> : null}
        <div className="review-operation-summary"><span>Total out on road <b>{count(route?.routeDispatched)}</b></span><span>Physical at station <b>{count(route?.routeAtStation)}</b></span><span>Still out / held <b>{count(route?.routeOutOnRoad)}</b></span><span>Delivered <b>{count(route?.routeDelivered)}</b></span><span>Returned <b>{count(route?.routeReturned)}</b></span></div>
        <p className="review-operation-note">This view covers every package assigned by Amazon on the selected date, regardless of EDD. Total out on road reconciles exactly to delivered + still out/held + returned. Physical at station means not yet assigned and sits outside that total.</p>
        <div className="review-operation-table" role="region" aria-label="All out-on-road half-hour history, scroll for all times and columns" tabIndex={0}>
          <table><thead><tr><th>Checkpoint</th><th>Physical at station</th><th>Total out on road</th><th>Still out / held</th><th>Delivered</th><th>Returned</th><th>Observation</th></tr></thead>
            <tbody>{t.rows.map(row => {
              const pointCounts = row.routeState === "Recorded" ? row.point?.counts : null;
              const final = row.label === "EOD" && t.routeFinal ? t.routeFinal : null;
              const c = pointCounts ?? final;
              const observedAt = pointCounts ? row.point?.performanceAt : final?.observedAt;
              const state = pointCounts ? row.routeState : final ? "Final daily total" : row.routeState;
              return <tr key={row.label} className={c ? "" : "review-operation-muted"}>
                <th scope="row">{row.label}</th><td>{count(c?.routeAtStation)}</td><td>{count(c?.routeDispatched)}</td><td>{count(c?.routeOutOnRoad)}</td><td>{count(c?.routeDelivered)}</td><td>{count(c?.routeReturned)}</td>
                <td>{observedAt ? <>{reviewClock(observedAt)}<small>{state}</small></> : state}</td>
              </tr>;
            })}</tbody></table>
        </div>
        <p className="review-operation-note">Half-hour route checkpoints are recorded from this release onward. Earlier review dates retain the authoritative final daily total at EOD; missing past checkpoints are not reconstructed from later data.</p>
        {route ? <p className="review-operation-note">Latest complete route source: {reviewClock(route.observedAt)} IST{route.source === "daily" ? " · Amazon daily snapshot" : ""}.</p> : <p className="review-operation-note">No complete route snapshot is available for this station and date.</p>}
      </>}
    </div>
  </ReviewDetails>;
}

export function PerformanceUtrDisciplineCard({ data, date }: { data: { discipline: UtrDiscipline; error: string | null }; date: string }) {
  const { discipline: d, error } = data;
  return <ReviewDetails className={`performance-fact-card review-operation-card ${d.late || d.notReported ? "late" : ""}`} name="performance-review-fact">
    <summary aria-label="UTR reporting discipline — view staff attendance">
      <span>UTR reporting discipline</span><strong>{error ? "Data unavailable" : d.scheduled ? `${d.onTime}/${d.scheduled} on time` : "No scheduled shifts"}</strong>
      <small>{d.late} late · {d.notReported} not reported{d.noShift ? ` · ${d.noShift} shift missing` : ""}</small>
      <UtrRepeatSummary/>
    </summary>
    <div className="review-operation-popover">
      <ReviewDetailsClose label="Close UTR reporting details"/>
      <header><div><b>UTR reporting · {formatDashboardDate(date)}</b><p>Station People staff · approved shifts and attendance</p></div><span className="review-operation-tag">{d.onTime}/{d.scheduled} on time</span></header>
      {error ? <p role="alert">{error}</p> : null}
      <div className="review-operation-summary"><span>Scheduled <b>{d.scheduled}</b></span><span>On time <b>{d.onTime}</b></span><span>Late <b>{d.late}</b></span><span>Not reported <b>{d.notReported}</b></span></div>
      <UtrAttendanceDrilldown discipline={d}/>
      <p className="review-operation-note">On time uses the approved shift’s reporting grace. {d.excluded} leave/off-duty staff are excluded; {d.noShift} without a linked shift are shown separately, never counted as on time. Worked hours come from attendance; an incomplete in/out pair is not shown as zero hours. Physical-location exceptions remain visible.</p>
    </div>
  </ReviewDetails>;
}

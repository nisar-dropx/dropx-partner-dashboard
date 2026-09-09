"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, ShieldCheck, Users, PackageSearch, ListFilter, X } from "lucide-react";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import type { EddStationPayload, EddStationResult } from "@/lib/ops-pulse/edd-worker";
import { eddCurrentState } from "@/lib/ops-pulse/edd-verification";
import { STATION_EDD_RULE, stationEddDate, stationEddPosition, stationEddToday, summarizeStationEdd, stationEddAssociates, stationEddAssociateKey, type StationEddDay, type StationEddFilter } from "@/lib/ops-pulse/station-edd";
import { ASSOCIATE_FOCUS, ASSOCIATE_SORTS, EDD_PERIODS, EDD_POSITIONS, STATUS_SORTS, TID_SORTS, readEddControls, selectEddAssociates, selectEddStatuses, selectEddTids, type EddQuery } from "@/lib/ops-pulse/edd-table-controls";
import { Field, ResetFilters, SortHeader, TablePager, TableSearch, useEddQuery } from "../edd-table-ui";
import { StationEddDownload } from "../station-edd-download";
import s from "../station-edd.module.css";

const n = (value: number) => value.toLocaleString("en-IN");
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
async function json<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Unable to load EDD.");
  return body;
}

export function StationEddDetailClient({ stationCode, initialQuery = {} }: { stationCode: string; initialQuery?: EddQuery }) {
  const [payload, setPayload] = useState<EddStationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [query, updateQuery] = useEddQuery(initialQuery);
  const controls = useMemo(() => readEddControls(new URLSearchParams(query)), [query]);
  const [page, setPage] = useState(1);
  const [openTid, setOpenTid] = useState<string | null>(null);
  const [today, setToday] = useState(stationEddToday());
  const reload = useCallback(async () => {
    const result = await json<EddStationResult>("/api/ops-pulse/station-edd?stationCode=" + encodeURIComponent(stationCode));
    setPayload(result.status === "ok" ? result.payload : null);
  }, [stationCode]);
  useEffect(() => {
    let cancelled = false;
    void json<EddStationResult>("/api/ops-pulse/station-edd?stationCode=" + encodeURIComponent(stationCode))
      .then(result => { if (!cancelled) setPayload(result.status === "ok" ? result.payload : null); })
      .catch(cause => { if (!cancelled) setError(cause.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const timer = setInterval(() => setToday(stationEddToday()), 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [stationCode]);
  function change(patch: EddQuery) { updateQuery(patch); setPage(1); }
  async function refresh(kind: "source" | "verify" | "reload") {
    setBusy(kind); setError(null); setMessage("");
    try {
      if (kind === "source") setPayload(await json<EddStationPayload>("/api/ops-pulse/station-edd/refresh?stationCode=" + encodeURIComponent(stationCode), "POST"));
      else if (kind === "verify") {
        const result = await json<{ verified: number; failed: number; busy: boolean }>("/api/ops-pulse/station-edd/verify?stationCode=" + encodeURIComponent(stationCode), "POST");
        setMessage(result.busy ? "Automatic checks are running, or no histories are due. Reload data for the latest results." : result.verified + " histories checked; " + result.failed + " could not be verified.");
        await reload();
      } else await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh."); }
    finally { setBusy(""); }
  }
  const packages = useMemo(() => [...new Map((payload?.packages ?? []).map(p => [p.trackingId, p])).values()], [payload]);
  const summary = useMemo(() => summarizeStationEdd(stationCode, payload ? packages : null, payload?.fetchedAt ?? null, today), [stationCode, payload, packages, today]);
  const todayAssociates = useMemo(() => stationEddAssociates(packages, today), [packages, today]);
  const tids = useMemo(() => selectEddTids(packages, controls, today), [packages, controls, today]);
  const associates = useMemo(() => selectEddAssociates(packages, controls, today), [packages, controls, today]);
  const statuses = useMemo(() => selectEddStatuses(summary.statuses, controls), [summary.statuses, controls]);
  const associateOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const p of packages) options.set(stationEddAssociateKey(p), p.isAccessPoint ? "Access point / locker" : p.driverName || p.verification?.driverName || p.driverId || "Associate not identified");
    return [...options].sort((a, b) => a[1].localeCompare(b[1]));
  }, [packages]);
  const periodLabel = EDD_PERIODS.find(([key]) => key === controls.day)![1];
  const positionLabel = EDD_POSITIONS.find(([key]) => key === controls.position)![1];
  const count = controls.view === "tids" ? tids.length : controls.view === "associates" ? associates.length : statuses.length;
  const size = Number(controls.size);
  const current = Math.min(page, Math.max(1, Math.ceil(count / size)));
  const start = (current - 1) * size;
  const associateTotals = associates.reduce((sum, a) => ({ sent: sum.sent + a.sent, delivered: sum.delivered + a.delivered, onRoad: sum.onRoad + a.onRoad, attempted: sum.attempted + a.attempted }), { sent: 0, delivered: 0, onRoad: 0, attempted: 0 });
  function report(kind: string) { return "/api/ops-pulse/station-edd/report?" + new URLSearchParams({ ...query, stationCode, report: kind, day: controls.day, position: controls.position }); }
  function select(position: StationEddFilter, day: StationEddDay = controls.day, associate = "", state = "") {
    change({ view: "tids", position, day, associate, state, query: "", history: "all", sentOnly: associate ? "true" : "" });
  }
  function reset() {
    if (controls.view === "tids") change({ position: "all", query: "", state: "", associate: "", history: "all", sentOnly: "", sort: "trackingId", direction: "asc" });
    else if (controls.view === "associates") change({ associateQuery: "", focus: "all", associateSort: "sent", associateDirection: "desc" });
    else change({ statusQuery: "", statusSort: "count", statusDirection: "desc" });
  }
  function sort(column: string) {
    if (controls.view === "associates") change({ associateSort: column, associateDirection: controls.associateSort === column && controls.associateDirection === "desc" ? "asc" : "desc" });
    else if (controls.view === "statuses") change({ statusSort: column, statusDirection: controls.statusSort === column && controls.statusDirection === "desc" ? "asc" : "desc" });
    else change({ sort: column, direction: controls.sort === column && controls.direction === "asc" ? "desc" : "asc" });
  }
  const sortOptions = controls.view === "associates" ? ASSOCIATE_SORTS : controls.view === "statuses" ? STATUS_SORTS : TID_SORTS;
  const sortKey = controls.view === "associates" ? "associateSort" : controls.view === "statuses" ? "statusSort" : "sort";
  const directionKey = controls.view === "associates" ? "associateDirection" : controls.view === "statuses" ? "statusDirection" : "direction";
  const badge = (position: StationEddFilter) => [s.badge, position === "delivered" ? s.badgeGreen : position === "hfr" ? s.badgePurple : position === "atStation" ? s.badgeOrange : ""].join(" ");
  return <div className={s.workspace}>
    <div className={s.breadcrumb}><a className={s.backLink} href="/edd/edds"><ArrowLeft size={16}/> All locations</a><div className={s.actions}><button className={s.button} disabled={loading || !!busy} onClick={() => void refresh("reload")}><RefreshCw size={14}/> Reload data</button><StationEddDownload href={"/api/ops-pulse/station-edd/report?stationCode=" + stationCode} label="Full station workbook"/><details className={s.advanced}><summary>Source tools</summary><div><p>Use only when the recorded data needs a source refresh. Automatic checks continue in the background.</p><button className={s.button} disabled={loading || !!busy} onClick={() => void refresh("source")}>Refresh source backlog</button><button className={s.button} disabled={loading || !!busy} onClick={() => void refresh("verify")}>Check next history batch</button></div></details></div></div>
    {error ? <p role="alert" className={s.error}>{error}</p> : null}{message ? <p role="status" className={s.notice}>{message}</p> : null}{busy ? <p className={s.notice} role="status">{busy === "source" ? "Refreshing source backlog. Large stations can take up to five minutes; existing data stays visible." : busy === "verify" ? "Checking tracking histories…" : "Loading latest data…"}</p> : null}
    {loading ? <div className={s.empty}>Loading station EDDs…</div> : !payload ? <div className={s.empty}>No observed records yet. Use Source tools to refresh this station. Missing data is not a zero count.</div> : <>
      <div className={s.contextBar}><span>Today’s station summary · {today} · IST</span><span>Latest observation {dateTime(payload.fetchedAt)} IST</span></div>
      <section className={s.metrics} aria-label="Today's station EDD position">{([
        ["atStation", "Pending first dispatch", summary.todayAtStation, "Never dispatched or attempted", "orange"],
        ["onRoad", "On the road", summary.todayOnRoad, "Dispatched · not completed", "blue"],
        ["delivered", "Delivered", summary.todayDelivered, "Recorded delivery outcome", "green"],
        ["hfr", "HFR", summary.todayHfr, "Attempted before today", "purple"],
        ["unverified", "Needs history check", summary.todayUnverified, "Excluded from confirmed pending", "neutral"]
      ] as const).map(([key, label, value, hint, tone]) => <button key={key} aria-pressed={controls.view === "tids" && controls.position === key && controls.day === "today"} className={[s.metric, s[tone], controls.view === "tids" && controls.position === key && controls.day === "today" ? s.selectedMetric : ""].join(" ")} onClick={() => select(key, "today")}><span>{label}</span><strong>{n(value)}</strong><small>{hint}</small></button>)}</section>
      <div className={s.coverageCompact}><ShieldCheck size={18}/><div><strong>{summary.todayUnverified ? n(summary.todayUnverified) + " due-today TIDs need a history check" : "No due-today TIDs are waiting for pending classification"}</strong><span>{n(summary.todayTotal)} known EDDs today · {n(todayAssociates.reduce((sum, a) => sum + a.sent, 0))} sent. {summary.missingDate ? n(summary.missingDate) + " records have an unconfirmed EDD date." : "No missing EDD dates in the retained records."}</span><details><summary>What does this mean?</summary><p>Pending needs complete, current history proving no dispatch or attempt. On-road and delivered outcomes can be known from source scans without fetching every historical event. {n(summary.historyVerified)} of today’s TIDs have complete history stored; this is not an overall completion percentage. Previously attempted parcels remain separate as HFR. Counts reflect observations and can change after refresh.</p></details></div></div>
      <section className={s.panel}>
        <div className={s.panelHead}><div><span className={s.eyebrow}>EXPLORE STATION EDDS</span><h2>{stationCode} · {controls.view === "associates" ? "Associates" : controls.view === "statuses" ? "Source statuses" : "Tracking IDs"}</h2><p>The period below applies to all three tables. Today’s summary above stays fixed.</p></div><Field label="EDD period"><select className={s.select} value={controls.day} onChange={e => change({ day: e.target.value })}>{EDD_PERIODS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>
        <div className={s.tabs} role="tablist" aria-label="Station EDD view">{([["tids", "Tracking IDs", PackageSearch], ["associates", "Associates", Users], ["statuses", "Source statuses", ListFilter]] as const).map(([key, label, Icon]) => <button id={"tab-" + key} aria-controls={"panel-" + key} key={key} role="tab" aria-selected={controls.view === key} className={[s.tab, controls.view === key ? s.activeTab : ""].join(" ")} onClick={() => change({ view: key })}><Icon size={14}/> {label}</button>)}</div>
        <div role="tabpanel" id={"panel-" + controls.view} aria-labelledby={"tab-" + controls.view}>
          <div className={s.filterPanel}>
            <div className={s.filterGrid}>
              {controls.view === "tids" ? <>
                <TableSearch label="Search tracking IDs" placeholder="TID, associate, order, city or PIN" value={controls.query} onChange={value => change({ query: value })}/>
                <Field label="Delivery position"><select className={s.select} value={controls.position} onChange={e => change({ position: e.target.value })}>{EDD_POSITIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
                <Field label="Associate"><select className={s.select} value={controls.associate} onChange={e => change({ associate: e.target.value, sentOnly: "" })}><option value="">All associates</option>{associateOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
                <Field label="Source status"><select className={s.select} value={controls.state} onChange={e => change({ state: e.target.value })}><option value="">All source statuses</option>{summary.statuses.map(row => <option key={row.state} value={row.state}>{row.state}</option>)}</select></Field>
                <Field label="History availability"><select className={s.select} value={controls.history} onChange={e => change({ history: e.target.value })}><option value="all">Any history availability</option><option value="complete">Complete history available</option><option value="incomplete">Incomplete / not checked</option></select></Field>
              </> : controls.view === "associates" ? <>
                <TableSearch label="Search associates" placeholder="Associate name or driver ID" value={controls.associateQuery} onChange={value => change({ associateQuery: value })}/>
                <Field label="Associate delivery filter"><select className={s.select} value={controls.focus} onChange={e => change({ focus: e.target.value })}>{ASSOCIATE_FOCUS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
              </> : <TableSearch label="Search source statuses" placeholder="Search raw source status" value={controls.statusQuery} onChange={value => change({ statusQuery: value })}/>}
              <Field label="Sort by"><select className={s.select} value={controls[sortKey]} onChange={e => change({ [sortKey]: e.target.value })}>{sortOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
              <Field label="Sort direction"><select className={s.select} value={controls[directionKey]} onChange={e => change({ [directionKey]: e.target.value })}><option value="asc">Ascending ↑</option><option value="desc">Descending ↓</option></select></Field>
            </div>
            <div className={s.resultBar}><div role="status"><strong>{n(count)} {controls.view === "tids" ? "matching TIDs" : controls.view === "associates" ? "matching associates" : "source statuses"}</strong><span>{periodLabel}{controls.view === "tids" ? " · " + positionLabel : ""}{controls.view === "associates" ? " · First-dispatch EDD cohort; prior-day HFR excluded" : ""}</span></div><div className={s.actions}><ResetFilters onClick={reset}/><StationEddDownload href={report(controls.view === "tids" ? "filtered" : controls.view)} label={controls.view === "tids" ? "Export " + n(count) + " TIDs" : controls.view === "associates" ? "Export associates" : "Export source statuses"} disabled={!count}/></div></div>
            {controls.view === "tids" && (controls.associate || controls.state || controls.sentOnly || controls.query || controls.history !== "all") ? <div className={s.chips}>
              {controls.query ? <span className={s.filterChip}>Search: {controls.query}<button aria-label="Clear TID search" onClick={() => change({ query: "" })}><X size={12}/></button></span> : null}
              {controls.associate ? <span className={s.filterChip}>Associate: {associateOptions.find(([id]) => id === controls.associate)?.[1] || controls.associate}<button aria-label="Clear associate filter" onClick={() => change({ associate: "", sentOnly: "" })}><X size={12}/></button></span> : null}
              {controls.state ? <span className={s.filterChip}>{controls.state}<button aria-label="Clear source status" onClick={() => change({ state: "" })}><X size={12}/></button></span> : null}
              {controls.sentOnly ? <span className={s.filterChip}>Dispatched cohort only<button aria-label="Include all assigned TIDs" onClick={() => change({ sentOnly: "" })}><X size={12}/></button></span> : null}
              {controls.history !== "all" ? <span className={s.filterChip}>History: {controls.history}<button aria-label="Clear history filter" onClick={() => change({ history: "all" })}><X size={12}/></button></span> : null}
            </div> : null}
          </div>
          {controls.view === "associates" ? <>
            <div className={s.inlineStats} aria-label="Filtered associate totals"><span>Sent <strong>{n(associateTotals.sent)}</strong></span><span>Delivered <strong>{n(associateTotals.delivered)}</strong></span><span>On road <strong>{n(associateTotals.onRoad)}</strong></span><span>Attempted / returned <strong>{n(associateTotals.attempted)}</strong></span><span className={s.muted}>Select a count to see its TIDs.</span></div>
            <div className={s.tableWrap}><table className={s.table} aria-label="Associate EDD results"><thead><tr>{ASSOCIATE_SORTS.map(([key, label]) => <SortHeader key={key} column={key} label={label} sort={controls.associateSort} direction={controls.associateDirection} onSort={sort} numeric={key !== "name"}/>)}</tr></thead><tbody>{associates.slice(start, start + size).map(a => <tr key={a.id}><td className={s.associateName}><strong>{a.name}</strong><small className={s.cellSub}>{a.id}</small></td>{([["all", a.sent], ["delivered", a.delivered], ["onRoad", a.onRoad], ["attempted", a.attempted]] as const).map(([position, value]) => <td key={position} className={s.numeric}><button className={s.numberLink} aria-label={a.name + " " + position + ": " + value + " TIDs"} onClick={() => select(position, controls.day, a.id)}>{n(value)}</button></td>)}<td className={s.numeric}>{Math.round(a.delivered / a.sent * 100)}%<span className={s.miniProgress}><span style={{ width: a.delivered / a.sent * 100 + "%" }}/></span></td></tr>)}</tbody></table></div>
          </> : controls.view === "statuses" ? <>
            <p className={s.tableHelp}>Raw source labels are shown for audit; they are not the same as EDD positions. Select a count to open all matching TIDs.</p>
            <div className={s.tableWrap}><table className={s.table} aria-label="Source status results"><thead><tr>{STATUS_SORTS.map(([key, label]) => <SortHeader key={key} column={key} label={key === "count" ? periodLabel : label} sort={controls.statusSort} direction={controls.statusDirection} onSort={sort} numeric={key !== "state"}/>)}</tr></thead><tbody>{statuses.slice(start, start + size).map(row => <tr key={row.state}><td>{row.state}</td><td className={s.numeric}><button className={s.numberLink} aria-label={row.state + " selected period: " + row.count + " TIDs"} onClick={() => select("all", controls.day, "", row.state)}>{n(row.count)}</button></td><td className={s.numeric}><button className={s.numberLink} aria-label={row.state + " all dates: " + row.total + " TIDs"} onClick={() => select("all", "all", "", row.state)}>{n(row.total)}</button></td></tr>)}</tbody></table></div>
          </> : <div className={s.tableWrap}><table className={s.table} aria-label="Tracking ID results"><thead><tr>{TID_SORTS.map(([key, label]) => <SortHeader key={key} column={key} label={label} sort={controls.sort} direction={controls.direction} onSort={sort}/>)}</tr></thead><tbody>{tids.slice(start, start + size).map(p => {
            const position = stationEddPosition(p, today);
            return <tr key={p.trackingId}><td><button className={s.tidButton} onClick={() => setOpenTid(p.trackingId)}>{p.trackingId}</button><small className={s.cellSub}>{p.orderingOrderId || "No order reference"}</small></td><td>{stationEddDate(p) || "Unconfirmed"}<small className={s.cellSub}>Promised {p.promisedDeliveryDate || "—"}</small></td><td><span className={badge(position)}>{EDD_POSITIONS.find(([key]) => key === position)?.[1]}</span></td><td>{eddCurrentState(p)}</td><td className={s.associateName}>{p.driverName || p.verification?.driverName || "—"}<small className={s.cellSub}>{p.driverId || "No driver ID"}</small></td><td>{p.verification?.firstAttemptAt ? dateTime(p.verification.firstAttemptAt) : p.verification?.historyComplete ? "No attempt recorded" : "Not verified"}</td><td>{p.city || "—"}<small className={s.cellSub}>{p.postalCode}</small></td><td>{p.verifiedAt ? dateTime(p.verifiedAt) : "Awaiting check"}<small className={s.cellSub}>IST</small></td></tr>;
          })}</tbody></table></div>}
          {!count ? <div className={s.empty}><strong>No results for this selection.</strong><p>Try another EDD period or reset this table’s filters. No results here does not mean the entire station has no pending work.</p><ResetFilters onClick={reset}/></div> : null}
          <TablePager count={count} page={current} size={size} onPage={setPage} onSize={value => change({ size: value })} noun={controls.view === "tids" ? "TIDs" : controls.view === "associates" ? "associates" : "statuses"}/>
          <div className={s.footer}>Exports include all matching rows, not just this page. Counts may change if source data refreshes. Dates and times use IST.</div>
        </div>
      </section>
      <details className={s.definitions}><summary>How EDD positions are counted</summary><p>{STATION_EDD_RULE}</p><p>{summary.excludedReverse} reverse records excluded. Only records observed within the last seven days are retained. “All observed dates” can include undated TIDs; the associate table requires a known EDD.</p></details>
    </>}
    <TrackingDetailModal trackingId={openTid} stationHint={stationCode} onClose={() => { setOpenTid(null); void reload().catch(() => {}); }}/>
  </div>;
}

"use client";
import "./review-edd-checkpoint.css";
import { useEffect, useRef, useState } from "react";
import { TrackingDetailModal } from "./tracking-detail-modal";
import { EddMultiSelect } from "@/app/ops-pulse/edd/edd-multi-select";
import { StationEddDownload } from "@/app/ops-pulse/station-edd/station-edd-download";
import type { EddCheckpointPackage } from "@/lib/ops-pulse/edd-movement";
import { reviewClock } from "@/lib/ops-pulse/review-operations";

export function ReviewEddCheckpoint({ station, day, observedAt, group, label, onClose }: {
  station: string; day: string; observedAt: string; group: string; label: string; onClose: () => void;
}) {
  const [query, setQuery] = useState(""), [page, setPage] = useState(1), [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ rows: EddCheckpointPackage[]; total: number; statuses: string[] } | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [tid, setTid] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const params = new URLSearchParams({ station, date: day, observedAt, group, query, page: String(page), statuses: [...statuses].join(",") });
  const url = "/api/ops-pulse/performance/edd-checkpoint?" + params;
  useEffect(() => { panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); panel.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let stopped = false;
    setLoading(true); setError("");
    fetch(url, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw Error(body.error || "Unable to load checkpoint");
      if (!stopped) setData(body);
    }).catch(cause => { if (!stopped) setError(cause instanceof Error ? cause.message : "Unable to load checkpoint"); })
      .finally(() => { clearTimeout(timeout); if (!stopped) setLoading(false); });
    return () => { stopped = true; clearTimeout(timeout); controller.abort(); };
  }, [url]);
  return <section ref={panel} tabIndex={-1} className="review-edd-checkpoint" aria-label="Checkpoint tracking IDs" onKeyDown={event => { if (event.key === "Escape" && !tid) { event.stopPropagation(); onClose(); } }}>
    <header><div><b>{station} · {label} · {reviewClock(observedAt)} IST</b><p>Recorded {day}. Select a tracking ID for its latest tracking history.</p></div><button className="review-details-close" type="button" onClick={onClose}>× Close</button></header>
    <div className="review-edd-checkpoint-controls">
      <input aria-label="Search checkpoint tracking IDs" placeholder="Tracking ID, associate or status" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/>
      <EddMultiSelect label="Source statuses" options={data?.statuses ?? []} selected={statuses} onChange={next => { setStatuses(next); setPage(1); }}/>
      <StationEddDownload href={url + "&format=xlsx"} label="Download Excel" disabled={loading || !!error || !data?.total}/>
    </div>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading tracking IDs…</p> : <>
      <p>{data?.total.toLocaleString("en-IN")} tracking IDs · Status below is the recorded checkpoint status, not a later live scan.</p>
      <div className="review-operation-table" tabIndex={0} role="region" aria-label="Checkpoint package list"><table><thead><tr><th>Tracking ID</th><th>Status at checkpoint</th><th>Associate</th><th>Attempt category</th></tr></thead><tbody>
        {data?.rows.map(row => <tr key={row[0]}><td><button type="button" className="review-edd-number" onClick={() => setTid(row[0])}>{row[0]}</button></td><td>{row[1] || "No current source observation"}</td><td>{row[3] || "—"}</td><td>{row[5] === "none" ? "—" : row[5] === "unknown" ? "History incomplete" : row[5].toUpperCase()}</td></tr>)}
      </tbody></table></div>
      <div className="review-edd-checkpoint-controls"><button type="button" disabled={page === 1} onClick={() => setPage(page-1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0)/100))}</span><button type="button" disabled={page*100 >= (data?.total ?? 0)} onClick={() => setPage(page+1)}>Next</button></div>
    </>}
    <TrackingDetailModal trackingId={tid} stationHint={station} onClose={() => setTid(null)}/>
  </section>;
}

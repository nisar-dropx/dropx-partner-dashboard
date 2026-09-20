"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { reviewReportDates, reportIst, type ReportRow } from "@/lib/ops-pulse/review-report";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";

type Station = { code: string; name: string; cluster: string };
type Preview = { generatedAt: string; rows: ReportRow[]; notes: string[]; sections: { name: string; count: number }[] };
export function ReviewReportBuilder({ stations }: { stations: Station[] }) {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`), [to, setTo] = useState(today);
  const [selected, setSelected] = useState(stations.map(s => s.code));
  const [stationSearch, setStationSearch] = useState(""), [query, setQuery] = useState(""), [status, setStatus] = useState("All"), [sort, setSort] = useState("date"), [page, setPage] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => () => active.current?.abort(), []);
  const clusters = useMemo(() => [...new Set(stations.map(s => s.cluster))].sort(), [stations]);
  let validation = "";
  try { reviewReportDates(from, to); if (!selected.length) validation = "Select at least one location."; } catch (e) { validation = (e as Error).message; }
  const invalidate = () => { generation.current++; active.current?.abort(); setPreview(null); setBusy(""); setError(""); setPage(0); };
  const toggle = (codes: string[], checked: boolean) => { invalidate(); setSelected(current => checked ? [...new Set([...current, ...codes])] : current.filter(s => !codes.includes(s))); };
  async function generate(format: "json" | "xlsx" | "pdf") {
    if (validation || busy) return;
    const controller = new AbortController(); active.current = controller;
    const requestGeneration = ++generation.current;
    setBusy(format); setError("");
    try {
      const params = new URLSearchParams({ from, to, stations: selected.join(","), format });
      const response = await fetch(`/api/ops-pulse/reports/reviews?${params}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw Error((await response.json()).error || "The report could not be generated.");
      if (format === "json") { const result = await response.json(); if (generation.current === requestGeneration) { setPreview(result); setPage(0); } }
      else {
        const blob = await response.blob();
        if (generation.current !== requestGeneration) return;
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = `OpsPulse-Review-Summary-${from}-to-${to}.${format}`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (e) { if (!controller.signal.aborted && generation.current === requestGeneration) setError((e as Error).message); }
    finally { if (generation.current === requestGeneration) { setBusy(""); active.current = null; } }
  }
  const rows = useMemo(() => (preview?.rows ?? []).filter(row => (status === "All" || row["Review status"] === status) && `${row.Station} ${row["Station name"]} ${row["Current reviewer"]}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === "misses" ? Number(b["Performance misses"] ?? -1) - Number(a["Performance misses"] ?? -1) : sort === "actions" ? Number(b["Open actions"]) - Number(a["Open actions"]) : sort === "station" ? String(a.Station).localeCompare(String(b.Station)) || String(b.Date).localeCompare(String(a.Date)) : String(b.Date).localeCompare(String(a.Date)) || String(a.Station).localeCompare(String(b.Station))), [preview, query, status, sort]);
  return <section className="review-report-builder" aria-labelledby="review-report-heading">
    <header><div><span className="review-report-eyebrow">Review archive · Excel & PDF</span><h2 id="review-report-heading">Review Summary</h2><p>One report across locations and performance dates. Includes scorecards, RCA, short delay reasons, action plans, review discussion and operational records.</p></div><span className="review-report-format">Standard format v1</span></header>
    <div className="review-report-controls">
      <label>From<input type="date" value={from} onChange={e => { invalidate(); setFrom(e.target.value); }}/></label>
      <label>To<input type="date" value={to} onChange={e => { invalidate(); setTo(e.target.value); }}/></label>
      <ReviewDetails className="review-report-stations"><summary>Locations <strong>{selected.length} selected</strong></summary><ReviewDetailsClose label="Close report location selection"/>
        <label>Find location<input value={stationSearch} onChange={e => setStationSearch(e.target.value)} placeholder="Station code or name"/></label>
        <div className="review-report-selection"><button type="button" onClick={() => toggle(stations.map(s => s.code), true)}>Select all permitted</button><button type="button" onClick={() => toggle(selected, false)}>Clear selection</button></div>
        <div className="review-report-checks">{clusters.map(cluster => { const codes = stations.filter(s => s.cluster === cluster).map(s => s.code); return <label key={cluster}><input type="checkbox" checked={codes.every(c => selected.includes(c))} onChange={e => toggle(codes, e.target.checked)}/>{cluster}</label>; })}</div>
        <div className="review-report-checks">{stations.filter(s => `${s.code} ${s.name}`.toLowerCase().includes(stationSearch.toLowerCase())).map(s => <label key={s.code}><input type="checkbox" checked={selected.includes(s.code)} onChange={e => toggle([s.code], e.target.checked)}/><span><b>{s.code}</b> · {s.name}</span></label>)}</div>
      </ReviewDetails>
    </div>
    <div className="review-report-actions"><button type="button" className="button" disabled={Boolean(validation || busy)} onClick={() => generate("json")}>Preview summary</button><button type="button" className="button secondary" disabled={Boolean(validation || busy)} onClick={() => generate("xlsx")}>Download Excel</button><button type="button" className="button secondary" disabled={Boolean(validation || busy)} onClick={() => generate("pdf")}>Download PDF</button><small>Up to 92 days · All selected locations · IST</small></div>
    {validation ? <p className="review-report-message">{validation}</p> : null}
    {busy ? <p role="status" className="review-report-message">{busy === "json" ? "Loading review summary" : `Preparing ${busy === "pdf" ? "PDF" : "Excel"}`}… Larger date ranges can take a little longer. <button type="button" onClick={invalidate}>Cancel</button></p> : null}
    {error ? <p role="alert" className="review-report-error">{error}</p> : null}
    <ReviewDetails className="review-report-help"><summary>What is included?</summary><ReviewDetailsClose label="Close report explanation"/><p>Saved RCA and plans; station-opening and UTR delay reasons; action owners/due dates; reviewer stages, bypass/proxy reasons and comments; vehicle arrival/unloading, EMD, recorded CPS costs and 30-minute EDD checkpoints. Missing data is labelled, never treated as zero. Raw biometric punch histories remain in the individual attendance drill-down.</p><p>Downloads include the entire location/date selection. The search, status and sort below only change the preview.</p></ReviewDetails>
    {preview ? <div className="review-report-preview"><div className="review-report-preview-head"><strong>{preview.rows.length} station-days · {preview.rows.filter(r => r["Review status"] === "Completed").length} completed</strong><small>Generated {reportIst(preview.generatedAt)}</small></div>
      <div className="review-report-controls"><label>Search preview<input placeholder="Station or reviewer" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/></label><label>Status<select value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}>{["All", "Not started", "In progress", "Completed"].map(s => <option key={s}>{s}</option>)}</select></label><label>Sort<select value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}><option value="date">Date · latest first</option><option value="station">Station · A–Z</option><option value="misses">Most performance misses</option><option value="actions">Most open actions</option></select></label></div>
      <div className="review-report-table-scroll" tabIndex={0} aria-label="Review summary table; scroll horizontally for more columns"><table><thead><tr>{["Date", "Station", "Review status", "Performance misses", "Missing performance RCA", "Open actions", "At station EDD cleared time", "Current reviewer"].map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.slice(page * 25, page * 25 + 25).map(row => <tr key={`${row.Date}-${row.Station}`}><td>{row.Date}</td><td><a href={`/performance?view=reviews&date=${row.Date}&review=${encodeURIComponent(String(row.Station))}`}>{row.Station}</a><small>{row["Station name"]}</small></td>{["Review status", "Performance misses", "Missing performance RCA", "Open actions", "At station EDD cleared time", "Current reviewer"].map(c => <td key={c}>{row[c] ?? "Not recorded"}</td>)}</tr>)}</tbody></table></div>
      {!rows.length ? <p className="review-report-message">No station-days match these preview filters.</p> : null}
      <footer><small>{rows.length} matching station-days · Page {page + 1} of {Math.max(1, Math.ceil(rows.length / 25))}</small><button type="button" disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</button><button type="button" disabled={(page + 1) * 25 >= rows.length} onClick={() => setPage(p => p + 1)}>Next</button></footer>
    </div> : null}
  </section>;
}

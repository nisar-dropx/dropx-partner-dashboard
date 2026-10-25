"use client";
import { useEffect, useState } from "react";
import { TrackingDetailModal } from "./tracking-detail-modal";
import styles from "./nl-loss.module.css";
const eventLabels: Record<string, string> = { activate: "Redispute activated", revoke: "Window closed", response: "Station response", vendor_response: "Vendor response", tracking: "LSC follow-up" };
type Event = { id: string; action: string; note: string; evidence_url: string | null; actor_name: string; created_at: string; tracking?: {tt_reference?:string;followup_status?:string;followup_on?:string} };
type Data = { window: { version: number; enabled: boolean; tt_reference?:string; tt_url?:string; followup_status?:string; followup_on?:string }; events: Event[]; canActivate: boolean; readOnly: boolean; row: { station_code: string; amount: number; source_status: string; details: { tid?: string; extra?: Record<string, string> } } };
export function LossCaseResponse({ month, caseKey }: { month: string; caseKey: string }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [action, setAction] = useState("response"), [note, setNote] = useState(""), [url, setUrl] = useState(""), [publicLink, setPublicLink] = useState(false), [tracking, setTracking] = useState(false);
  const [tt, setTt]=useState(""), [ttUrl,setTtUrl]=useState(""), [ttStatus,setTtStatus]=useState("filed"), [followup,setFollowup]=useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/ops-pulse/losses/case-response?${new URLSearchParams({ month, case: caseKey })}`, { signal: controller.signal, cache: "no-store" })
      .then(async r => { const j = await r.json(); if (!r.ok) throw Error(j.error); return j; })
      .then(j => { setData(j); setTt(j.window.tt_reference||""); setTtUrl(j.window.tt_url||""); setTtStatus(j.window.followup_status||"preparing"); setFollowup(j.window.followup_on||""); setAction(j.window.enabled ? "response" : j.canActivate ? "activate" : "response"); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [month, caseKey, revision]);
  const x = data?.row.details.extra || {};
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!data) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/ops-pulse/losses/case-response", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, case_key: caseKey, version: data.window.version, action, note, evidence_url: url, public_confirmed: publicLink, tt_reference:tt,tt_url:ttUrl,followup_status:ttStatus,followup_on:followup }) });
      const j = await r.json(); if (!r.ok) throw Error(j.error);
      setNote(""); setUrl(""); setPublicLink(false); setRevision(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Response could not be saved."); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 860, margin: "0 auto", padding: 16 }}>
    <a href="/team-ops/losses/nl">← Losses</a>
    <h1>Redispute response</h1>
    {error ? <p role="alert" className={styles.error}>{error} <button onClick={() => { setError(""); setRevision(n => n + 1); }}>Reload</button></p> : null}
    {!data ? <p role="status">Loading case…</p> : <>
      {data.canActivate ? <p><a href="/team-ops/losses/redisputes">← Redispute desk</a></p> : null}
      <div className={styles.panelHead}><button className={styles.button} onClick={() => setTracking(true)}>{data.row.station_code} · {data.row.details.tid || caseKey} ↗</button><strong>₹{Number(data.row.amount).toLocaleString("en-IN")} · {data.row.source_status}</strong></div>
      <TrackingDetailModal trackingId={tracking ? data.row.details.tid || null : null} stationHint={data.row.station_code} onClose={() => setTracking(false)} />
      <p className={styles.hint}>Redispute {data.window.enabled ? "activated for this TID" : "not activated"}. Recovery remains outstanding until a confirmed outcome.</p>
      <section className={styles.allocation}>
        <h2>Vendor response</h2>
        {x.partner_remarks ? <details><summary>Earlier station response</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.partner_remarks}</p></details> : null}
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.nl_remarks || x.nl_res || "No vendor response recorded yet."}</p>
        {x.nl_remarks_by ? <small>{x.nl_remarks_by} · {x.nl_remarks_time_ist} IST</small> : null}
      </section>
      {!data.readOnly && (data.canActivate || data.window.enabled) ? <form onSubmit={save} className={styles.detail}>
        {data.canActivate ? <label>Action<select value={action} onChange={e => setAction(e.target.value)}>
          {!data.window.enabled ? <option value="activate">Activate redispute for this TID</option> : <><option value="response">Station response</option><option value="revoke">Close response window</option></>}
          <option value="vendor_response">Record vendor response</option>
          {data.window.enabled?<option value="tracking">Update LSC TT / follow-up</option>:null}
        </select></label> : <h3>Station response</h3>}
        {action === "tracking" ? <>
          <label>LSC TT reference<input value={tt} onChange={e=>setTt(e.target.value)} maxLength={160}/></label>
          <label>LSC ticket link (optional)<input type="url" value={ttUrl} onChange={e=>setTtUrl(e.target.value)} maxLength={2000}/></label>
          <label>Status<select value={ttStatus} onChange={e=>setTtStatus(e.target.value)}>{[["preparing","Preparing"],["filed","TT filed"],["with_vendor","With vendor"],["returned","Needs response"],["won","Won · source verification required"],["lost","Lost · continue recovery"],["closed","Close follow-up"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          <label>Next follow-up<input type="date" value={followup} onChange={e=>setFollowup(e.target.value)} required={["filed","with_vendor","returned"].includes(ttStatus)}/></label>
        </> : null}
        <label>Details<textarea required minLength={10} maxLength={4000} rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={action === "activate" ? "Why is another dispute warranted for this TID?" : "What happened, evidence and requested resolution."} /></label>
        <label>Evidence link (optional)<input type="url" value={url} onChange={e => { setUrl(e.target.value); setPublicLink(false); }} maxLength={2000} placeholder="Google Drive link" /></label>
        <small>For videos or photos, share a Drive link with “Anyone with the link can view”. No attachment required.</small>
        {url ? <label className={styles.check}><input type="checkbox" required checked={publicLink} onChange={e => setPublicLink(e.target.checked)} />Anyone with the link can view</label> : null}
        <button className={styles.button} disabled={busy || note.trim().length < 10 || (!!url && !publicLink)}>{busy ? "Saving…" : "Save"}</button>
        <small>Saved for the case team. This does not submit a dispute to Amazon.</small>
      </form> : null}
      <details className={styles.compactDetails} open><summary>Response history · {data.events.length}</summary>{data.events.map(event => <article className={styles.allocation} key={event.id}>
        <strong>{eventLabels[event.action] || event.action}</strong>
        <small> · {event.actor_name} · {new Date(event.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</small>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.note}</p>
        {event.tracking?<small>TT {event.tracking.tt_reference||"pending"} · {event.tracking.followup_status} · Follow-up {event.tracking.followup_on||"—"}</small>:null}
        {event.evidence_url ? <a href={event.evidence_url} target="_blank" rel="noreferrer">View evidence ↗</a> : null}
      </article>)}</details>
    </>}
  </main>;
}

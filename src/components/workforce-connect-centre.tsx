"use client";

import { useCallback, useEffect, useState } from "react";
import { Headphones, LockKeyhole, RefreshCw, Send, Paperclip } from "lucide-react";
import styles from "./workforce-connect-centre.module.css";

type Case = { id: string; case_number: string; channel: string; category: string; subject: string; description: string; status: string; urgency: string; reporter_name: string; reporter_code: string | null; reporter_designation: string | null; identity_protected: boolean; assigned_profile_id: string | null; due_at: string | null; created_at: string; last_activity_at: string };
type Detail = { conversation: Case; owner: string; station: string; messages: Array<{ id: string; author_kind: string; visibility: string; body: string; created_at: string }>; attachments: Array<{ id: string; name: string; url: string | null }>; events: Array<{ id: string; event_type: string; to_status: string | null; created_at: string }> };
const statuses: Record<string, string> = { submitted: "Submitted", acknowledged: "Acknowledged", in_review: "Under review", action_required: "Associate input needed", resolved: "Resolved", closed: "Closed", dismissed: "Dismissed" };
const when = (value: string | null) => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "Not set";

export function WorkforceConnectCentre({ canRespond }: { canRespond: boolean }) {
  const [channel, setChannel] = useState("connect");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("open");
  const [owner, setOwner] = useState("");
  const [page, setPage] = useState(0);
  const [cases, setCases] = useState<Case[]>([]);
  const [summary, setSummary] = useState({ total: 0, open: 0, overdue: 0 });
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [nextStatus, setNextStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ channel, q: query, status, owner, page: String(page) });
        const response = await fetch(`/api/workforce-connect?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (controller.signal.aborted) return;
        setCases(data.cases); setSummary({ total: data.total, open: data.open, overdue: data.overdue });
        setSelected(current => data.cases.some((item: Case) => item.id === current) ? current : data.cases[0]?.id ?? "");
      } catch (reason) {
        if (!controller.signal.aborted) { setCases([]); setSelected(""); setError(reason instanceof Error ? reason.message : "Unable to load inbox."); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [channel, query, status, owner, page, revision]);

  useEffect(() => {
    setDetail(null); setMessage(""); setNote("");
    if (!selected) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/workforce-connect?case=${encodeURIComponent(selected)}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!controller.signal.aborted) { setDetail(data); setNextStatus(data.conversation.status); }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to open conversation."); }
    })();
    return () => controller.abort();
  }, [selected, revision]);

  async function act(intent: string, value = "") {
    if (!canRespond || saving || !selected) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/workforce-connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId: selected, intent, value }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setNotice(data.notice); refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save."); }
    finally { setSaving(false); }
  }

  const current = detail?.conversation;
  const confidential = current?.identity_protected || current?.channel === "integrity";
  return <main className={styles.centre}>
    <header className={styles.hero}><div><small>DIRECT WORKFORCE SUPPORT</small><h1>Workforce Connect Centre</h1><p>DropX One conversations for Workforce profiles. People conversations stay in People.</p></div>
      <div className={styles.stats}><span><b>{summary.open}</b>Open cases</span><span><b>{summary.overdue}</b>Past response target</span><button type="button" onClick={refresh} disabled={loading || saving} aria-label="Refresh inbox"><RefreshCw size={18} /></button></div>
    </header>
    <nav className={styles.tabs} aria-label="Conversation channel">
      <button type="button" aria-pressed={channel === "connect"} disabled={saving} onClick={() => { setChannel("connect"); setPage(0); }}><Headphones size={18} />Workforce Help</button>
      <button type="button" aria-pressed={channel === "integrity"} disabled={saving} onClick={() => { setChannel("integrity"); setPage(0); }}><LockKeyhole size={18} />Speak Up · confidential</button>
    </nav>
    {error ? <div className={styles.error} role="alert">{error} <button type="button" onClick={refresh}>Retry</button></div> : null}
    {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
    {!canRespond ? <p className={styles.notice}>Read-only access. Reply permission is managed under Users & Access → Workforce Connect Centre.</p> : null}
    <div className={styles.layout}>
      <aside className={styles.panel} aria-label="Workforce conversations">
        <div className={styles.panelHead}><h2>Conversations</h2><small>{loading ? "Loading…" : `${summary.total} matching cases`}</small></div>
        <div className={styles.filters}>
          <label>Search<input value={query} disabled={saving} placeholder="Case, subject, name or DropX ID" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
          <label>Status<select value={status} disabled={saving} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">All statuses</option><option value="open">Open cases</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Owner<select value={owner} disabled={saving} onChange={event => { setOwner(event.target.value); setPage(0); }}><option value="">Any owner</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option></select></label>
        </div>
        <div className={styles.caseList}>{cases.map(item => <button className={item.id === selected ? styles.selected : ""} key={item.id} type="button" disabled={saving} onClick={() => { setSelected(item.id); setNotice(""); setError(""); }}>
          <small>{item.case_number} · {item.category}</small><strong>{item.subject}</strong><span>{item.reporter_name}{item.reporter_code ? ` · ${item.reporter_code}` : ""}</span><div><b className={styles.badge}>{statuses[item.status]}</b><time>{when(item.last_activity_at)}</time></div>
        </button>)}{!loading && !cases.length ? <p className={styles.empty}>{error ? "Inbox unavailable. Retry to load your cases." : "No conversations match these filters."}</p> : null}</div>
        <div className={styles.pagination}><button type="button" disabled={!page || loading || saving} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page + 1}</span><button type="button" disabled={(page + 1) * 50 >= summary.total || loading || saving} onClick={() => setPage(value => value + 1)}>Next</button></div>
      </aside>
      {detail && current ? <section className={styles.detail} aria-label="Selected conversation">
        <header className={styles.detailHead}><small>{current.case_number} · {current.urgency} priority</small><h2>{current.subject}</h2><span>{current.category} · {statuses[current.status]}</span></header>
        <div className={`${styles.panel} ${styles.identity}`}><strong>{current.reporter_name}</strong><p>{confidential ? "Identity protected. Only company-wide Connect reviewers can open this case." : [current.reporter_code, current.reporter_designation, detail.station].filter(Boolean).join(" · ")}</p></div>
        <div className={styles.meta}><article><small>Assigned to</small><b>{detail.owner}</b></article><article><small>Response target</small><b>{when(current.due_at)}</b></article><article><small>Reported</small><b>{when(current.created_at)}</b></article></div>
        <section className={styles.panel}><div className={styles.panelHead}><h2>Conversation</h2><small>Replies reach this associate’s Connect inbox and app notifications.</small></div>
          <div className={styles.messages}>{detail.messages.filter(item => item.visibility !== "internal").map(item => <article key={item.id} className={item.author_kind === "reporter" ? styles.reporter : styles.reply}><small>{item.author_kind === "reporter" ? current.reporter_name : "Workforce Support"}</small><p>{item.body}</p><time>{when(item.created_at)}</time></article>)}</div>
          {canRespond && !["closed", "dismissed"].includes(current.status) ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void act("reply", message); }}><label>Reply to associate<textarea value={message} onChange={event => setMessage(event.target.value)} minLength={2} maxLength={3000} required rows={4} placeholder="Write a clear, helpful response…" /></label><button type="submit" disabled={saving || message.trim().length < 2} className={styles.primary}><Send size={16} />{saving ? "Saving…" : "Send reply"}</button></form> : null}
        </section>
        {detail.attachments.length ? <section className={`${styles.panel} ${styles.attachments}`}><h2>Attachments</h2>{detail.attachments.map(file => file.url ? <a key={file.id} href={file.url} target="_blank" rel="noreferrer"><Paperclip size={15} />{file.name}</a> : <span key={file.id}>{file.name} · Link unavailable; refresh to retry</span>)}</section> : null}
        {canRespond ? <div className={styles.controls}><section className={styles.panel}><h2>Ownership & status</h2><button type="button" disabled={saving} onClick={() => void act("assign")}>Assign to me</button><form onSubmit={event => { event.preventDefault(); void act("status", nextStatus); }}><label>Status<select value={nextStatus} onChange={event => setNextStatus(event.target.value)}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="submit" disabled={saving || nextStatus === current.status}>Update status</button></form></section>
          <section className={styles.panel}><h2>Private team note</h2><form onSubmit={event => { event.preventDefault(); void act("note", note); }}><label>Not visible to the associate<textarea value={note} onChange={event => setNote(event.target.value)} minLength={2} maxLength={3000} rows={3} required /></label><button type="submit" disabled={saving || note.trim().length < 2}>Add note</button></form></section></div> : null}
        <details className={`${styles.panel} ${styles.history}`}><summary>Private notes & activity</summary>{detail.messages.filter(item => item.visibility === "internal").map(item => <article key={item.id}><p>{item.body}</p><small>{when(item.created_at)}</small></article>)}{detail.events.map(item => <p key={item.id}>{item.event_type.replaceAll("_", " ")}{item.to_status ? ` · ${statuses[item.to_status]}` : ""}<small>{when(item.created_at)}</small></p>)}</details>
      </section> : <section className={`${styles.panel} ${styles.empty}`}>{selected ? "Loading conversation…" : "Select a conversation to review and respond."}</section>}
    </div>
  </main>;
}

"use client";
import { useEffect, useRef, useState } from "react";
import { Eye, Search, X, ArrowRight, ShieldCheck } from "lucide-react";
import { connectAccountRoute } from "../lib/connect-account-routing";
import type { PreviewTarget } from "../lib/connect-preview-policy";

type PreviewUser = PreviewTarget & { name: string; email: string; reference: string; role: string };
export async function exitConnectPreview() {
  const result = await fetch("/api/connect/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exit: true }) });
  if (!result.ok) throw new Error("Unable to exit preview. Please retry.");
  window.location.assign("/accounts");
}
export function ConnectPreviewSwitcher({ active, name, banner = false }: { active: boolean; name?: string | null; banner?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PreviewUser[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else { dialog.current?.close(); }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setUsers([]); setError("");
    if (query.trim().length < 2) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/connect/preview?q=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to search profiles.");
        if (!controller.signal.aborted) setUsers(payload.users || []);
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  function close() { if (saving) return; setOpen(false); trigger.current?.focus(); }
  async function select(user: PreviewUser) {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/connect/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId: user.companyId, profileType: user.profileType, id: user.id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to open preview.");
      window.location.assign(connectAccountRoute("/dashboard", payload.account));
    } catch (e) { setError((e as Error).message); setSaving(false); }
  }
  async function exit() { setSaving(true); setError(""); try { await exitConnectPreview(); } catch (e) { setError((e as Error).message); setSaving(false); } }
  if (banner) return <section className="dx-preview-banner" aria-label="User preview">
    <Eye aria-hidden="true" /><span><strong>Viewing {name || "user"}</strong><small>Read-only preview · Your own account stays signed in</small></span>
    <button disabled={saving} onClick={() => void exit()}>Exit preview</button>{error ? <p role="alert">{error}</p> : null}
  </section>;
  return <div className="dx-preview-control">
    <button className="dx-preview-trigger" ref={trigger} onClick={() => setOpen(true)} aria-haspopup="dialog"><Eye aria-hidden="true" /><span>{active ? "Switch preview" : "View as user"}</span></button>
    <dialog className="dx-preview-dialog" ref={dialog} onCancel={e => { e.preventDefault(); close(); }} aria-labelledby="dx-preview-title">
      <header><span className="dx-preview-icon"><Eye /></span><div><h2 id="dx-preview-title">View as user</h2><p>See their DropX One workspace.</p></div><button aria-label="Close user picker" onClick={close} disabled={saving}><X /></button></header>
      <div className="dx-preview-search"><Search aria-hidden="true" /><input autoFocus type="search" aria-label="Search users" placeholder="Name, mobile, email or DropX ID" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <p className="dx-preview-hint"><ShieldCheck aria-hidden="true" />Read-only. No submissions, approvals or account changes.</p>
      {error ? <p className="dx-preview-error" role="alert">{error}</p> : null}
      <div className="dx-preview-results" aria-busy={loading || saving}>
        {loading ? <p role="status">Finding profiles…</p> : users.length ? users.map(user => <button disabled={saving} key={`${user.profileType}:${user.companyId}:${user.id}`} onClick={() => void select(user)}>
          <span className="dx-preview-initial">{user.name[0]}</span><span><strong>{user.name}</strong><small>{user.role} · {user.profileType}{user.reference ? ` · ${user.reference}` : ""}</small><small>{user.email}</small></span><ArrowRight aria-hidden="true" />
        </button>) : <p role="status">{query.trim().length < 2 ? "Type at least 2 characters to find a profile." : "No matching profiles. Try another name or ID."}</p>}
      </div>
      <footer>Choose the exact profile when someone has more than one role.</footer>
    </dialog>
  </div>;
}

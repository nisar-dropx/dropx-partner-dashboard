"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PreviewUser = { id: string; name: string; email: string; role: string; scope: string };

export function OwnerPreviewSwitcher({ active, name }: { active: boolean; name: string }) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<PreviewUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter(user => !q || `${user.name} ${user.email} ${user.role}`.toLowerCase().includes(q));
  }, [query, users]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("mousedown", outside);
    return () => { document.removeEventListener("keydown", dismiss); document.removeEventListener("mousedown", outside); };
  }, [open]);

  useEffect(() => {
    if (!open || users !== null) return;
    const abort = new AbortController();
    setBusy(true); setError("");
    fetch("/api/owner-preview", { cache: "no-store", signal: abort.signal })
      .then(async response => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Unable to load users."); return payload; })
      .then(payload => { if (!abort.signal.aborted) { setBusy(false); setUsers(Array.isArray(payload.users) ? payload.users : []); } })
      .catch(reason => { if (!abort.signal.aborted) setError(reason.message || "Unable to load users."); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [open, users]);

  async function select(userId: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/owner-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to switch view.");
      window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to switch view."); setBusy(false); }
  }

  return <div className="owner-preview-switcher" ref={ref}>
    <button className={active ? "active" : ""} type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{active ? `Viewing ${name}` : "View as user"}</button>
    {active ? <button type="button" disabled={busy} onClick={() => select("")}>Exit preview</button> : null}
    {open ? <div className="owner-preview-menu" role="dialog" aria-label="View as user">
      <strong>View as user</strong><small>Read-only. Your administrator session stays signed in.</small>
      <label><span className="sr-only">Search users</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, email or designation" autoFocus /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div>{busy && users === null ? <p>Loading users…</p> : filtered.slice(0, 120).map(user => <button key={user.id} disabled={busy} type="button" onClick={() => select(user.id)}>
        <strong>{user.name}</strong><small>{user.role} · {user.scope}</small><span>{user.email}</span>
      </button>)}
      {!busy && users !== null && !filtered.length ? <p>No active portal users match.</p> : null}</div>
    </div> : null}
    {!open && error ? <span role="alert">{error}</span> : null}
  </div>;
}

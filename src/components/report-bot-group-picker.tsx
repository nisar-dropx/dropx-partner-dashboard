"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Loader2, Megaphone, Plus, RefreshCw, Search, Users, X } from "lucide-react";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";

type AvailableGroup = { id: string; subject: string; size: number; announce: boolean; selected: boolean };

function SaveButton({ count, ready }: { count: number; ready: boolean }) {
  const { pending } = useFormStatus();
  return (
    // Never save before the list loaded: an empty selection would remove every group.
    <button type="submit" className={`${s.button} ${s.primary}`} disabled={pending || !ready}>
      {pending ? <Loader2 size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />}
      Save {count} group{count === 1 ? "" : "s"}
    </button>
  );
}

/**
 * "Add or remove groups": every WhatsApp group the linked number is in, live from the
 * worker. Only ticked groups are listened to and shown on the Groups page.
 */
export function GroupPicker({ action, disabled }: { action: (form: FormData) => void | Promise<void>; disabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<AvailableGroup[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/report-bot/groups", { cache: "no-store" });
      const payload = await response.json() as { groups?: AvailableGroup[]; error?: string };
      if (!response.ok || !payload.groups) throw new Error(payload.error ?? "Could not load groups.");
      setGroups(payload.groups);
      setSelected(new Set(payload.groups.filter((group) => group.selected).map((group) => group.id)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load groups.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void load();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (groups ?? []).filter((group) => !needle || group.subject.toLowerCase().includes(needle));
  }, [groups, query]);

  const payload = JSON.stringify((groups ?? []).filter((group) => selected.has(group.id)).map(({ id, subject, size }) => ({ id, subject, size })));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      <button type="button" className={`${s.button} ${s.primary}`} onClick={() => setOpen(true)} disabled={disabled}>
        <Plus size={15} aria-hidden />Add or remove groups
      </button>
      <dialog ref={ref} className={`${s.modal} ${s.modalNarrow}`} aria-labelledby="group-picker-title" onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <form action={action} className={s.picker}>
          <input type="hidden" name="selected" value={payload} />
          <div className={s.modalHead}>
            <div>
              <strong id="group-picker-title">WhatsApp groups</strong>
              <div className={s.hint}>Tick the report groups. The bot ignores every other chat.</div>
            </div>
            <button type="button" className={`${s.button} ${s.small} ${s.ghost}`} onClick={() => setOpen(false)} aria-label="Close"><X size={16} aria-hidden /></button>
          </div>
          <div className={s.pickerSearch}>
            <Search size={16} aria-hidden />
            <input className={s.input} type="search" placeholder="Search groups" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search groups" />
            <button type="button" className={`${s.button} ${s.small} ${s.ghost}`} onClick={() => void load()} disabled={loading} aria-label="Reload groups from WhatsApp">
              <RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden />
            </button>
          </div>
          <div className={s.pickerList} role="group" aria-label="Groups">
            {loading && !groups ? <div className={s.modalStatus}><Loader2 size={20} className="spin" aria-hidden />Loading groups from WhatsApp…</div> : null}
            {error ? <div className={s.modalStatus} role="alert">{error}</div> : null}
            {groups && !visible.length ? <div className={s.modalStatus}>{groups.length ? "No group matches that search." : "This number isn't in any WhatsApp group yet."}</div> : null}
            {visible.map((group) => (
              <label key={group.id} className={`${s.pickerRow} ${selected.has(group.id) ? s.pickerRowOn : ""}`}>
                <input type="checkbox" checked={selected.has(group.id)} onChange={() => toggle(group.id)} />
                <span className={s.avatar} aria-hidden>{group.subject.slice(0, 1).toUpperCase()}</span>
                <span className={s.pickerText}>
                  <strong>{group.subject}</strong>
                  <small><Users size={12} aria-hidden /> {group.size} members{group.announce ? <> · <Megaphone size={12} aria-hidden /> admins only can post</> : null}</small>
                </span>
              </label>
            ))}
          </div>
          <div className={`${s.modalFoot}`}>
            <span className={s.hint}>{selected.size} selected</span>
            <SaveButton count={selected.size} ready={Boolean(groups) && !loading && !error} />
          </div>
        </form>
      </dialog>
    </>
  );
}

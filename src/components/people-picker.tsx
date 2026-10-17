"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./people-picker.module.css";

export type PickerOption = { key: string; label: string; detail?: string };

/** Searchable multi-select dropdown for people, with chips for the selection and select-all-shown. */
export function PeoplePicker({ options, value, onChange, placeholder = "Choose people", disabled = false, max = 50 }: {
  options: PickerOption[]; value: string[]; onChange: (next: string[]) => void; placeholder?: string; disabled?: boolean; max?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const byKey = useMemo(() => new Map(options.map((o) => [o.key, o])), [options]);
  const term = q.trim().toLowerCase();
  const shown = useMemo(() => options.filter((o) => !term || `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(term)).slice(0, 200), [options, term]);
  const selected = new Set(value);
  const toggle = (k: string) => onChange(selected.has(k) ? value.filter((v) => v !== k) : value.length >= max ? value : [...value, k]);
  const allShown = shown.length > 0 && shown.every((o) => selected.has(o.key));
  const toggleShown = () => onChange(allShown ? value.filter((v) => !shown.some((o) => o.key === v)) : [...new Set([...value, ...shown.map((o) => o.key)])].slice(0, max));
  return (
    <div className={styles.picker} ref={box}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((v) => !v)} disabled={disabled} aria-expanded={open} aria-haspopup="listbox">
        <span>{value.length ? `${value.length} selected` : placeholder}</span><i aria-hidden>▾</i>
      </button>
      {value.length ? (
        <div className={styles.chips}>
          {value.slice(0, 12).map((k) => <span key={k} className={styles.chip}>{byKey.get(k)?.label ?? "Person"}<button type="button" aria-label="Remove" onClick={() => toggle(k)}>×</button></span>)}
          {value.length > 12 ? <span className={styles.more}>+{value.length - 12} more</span> : null}
          <button type="button" className={styles.clear} onClick={() => onChange([])}>Clear</button>
        </div>
      ) : null}
      {open ? (
        <div className={styles.menu}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${options.length} people`} aria-label="Search people" />
          <label className={styles.all}><input type="checkbox" checked={allShown} onChange={toggleShown} disabled={!shown.length} />Select all shown{term ? " (filtered)" : ""}</label>
          <div className={styles.list} role="listbox" aria-multiselectable>
            {shown.map((o) => (
              <label key={o.key} className={styles.option}>
                <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} />
                <span><b>{o.label}</b>{o.detail ? <small>{o.detail}</small> : null}</span>
              </label>
            ))}
            {!shown.length ? <p className={styles.none}>{options.length ? "No one matches." : "No people available."}</p> : null}
          </div>
          <div className={styles.foot}><span>{value.length}/{max} selected</span><button type="button" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      ) : null}
    </div>
  );
}

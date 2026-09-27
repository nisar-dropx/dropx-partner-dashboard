"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type FleetFilterOption = { value: string; label: string; helper?: string };

export function FleetMultiSelect({
  allLabel,
  disabled = false,
  label,
  onChange,
  options,
  searchable = true,
  values
}: {
  allLabel: string;
  disabled?: boolean;
  label: string;
  onChange: (values: string[]) => void;
  options: FleetFilterOption[];
  searchable?: boolean;
  values: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(values), [values]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options.filter((option) => !needle || `${option.label} ${option.helper ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function toggle(value: string) {
    onChange(selected.has(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  function toggleFiltered() {
    const visible = filtered.map((option) => option.value);
    const allSelected = visible.length > 0 && visible.every((value) => selected.has(value));
    onChange(allSelected ? values.filter((value) => !visible.includes(value)) : [...new Set([...values, ...visible])]);
  }

  const selectedOptions = options.filter((option) => selected.has(option.value));
  const summary = !selectedOptions.length
    ? allLabel
    : selectedOptions.length <= 2
      ? selectedOptions.map((option) => option.label).join(", ")
      : `${selectedOptions.length} selected`;

  return <div className="fc-multi-select" ref={root}>
    <span className="fc-filter-label">{label}</span>
    <button aria-expanded={open} className={open ? "open" : ""} disabled={disabled} onClick={() => setOpen((value) => !value)} type="button"><span title={summary}>{summary}</span><ChevronDown size={14} /></button>
    {open ? <div className="fc-multi-menu">
      <div className="fc-multi-menu-head"><strong>{label}</strong>{values.length ? <button onClick={() => onChange([])} type="button">Clear</button> : <button aria-label="Close" onClick={() => setOpen(false)} type="button"><X size={13} /></button>}</div>
      {searchable && options.length > 6 ? <label className="fc-multi-search"><Search size={13} /><input autoFocus onChange={(event) => setQuery(event.target.value)} placeholder={`Find ${label.toLowerCase()}`} value={query} /></label> : null}
      <button className="fc-multi-all" onClick={toggleFiltered} type="button"><span>{filtered.length > 0 && filtered.every((option) => selected.has(option.value)) ? <Check size={12} /> : null}</span><div><strong>Select all shown</strong><small>{filtered.length} options</small></div></button>
      <div className="fc-multi-options">{filtered.map((option) => <button className={selected.has(option.value) ? "selected" : ""} key={option.value} onClick={() => toggle(option.value)} type="button"><span>{selected.has(option.value) ? <Check size={12} /> : null}</span><div><strong>{option.label}</strong>{option.helper ? <small>{option.helper}</small> : null}</div></button>)}{!filtered.length ? <p>No matching option</p> : null}</div>
    </div> : null}
  </div>;
}


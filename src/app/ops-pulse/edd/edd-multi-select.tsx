"use client";

import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

function optionText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionText).join(" ");
  return isValidElement<{ children?: ReactNode }>(value) ? optionText(value.props.children) : "";
}

export function EddMultiSelect({
  label,
  options,
  selected,
  onChange,
  renderOption
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Custom display per option (e.g. "22 Aug · 313") while filtering still matches the raw option value. */
  renderOption?: (option: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleOptions = options.filter(option => `${option} ${renderOption ? optionText(renderOption(option)) : ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggle(option: string) {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  }

  const summary = selected.size === 0
    ? `All ${label.toLowerCase()}`
    : selected.size === 1
      ? (renderOption ? renderOption([...selected][0]) : [...selected][0])
      : `${selected.size} ${label.toLowerCase()} selected`;

  return (
    <div className="edd-multiselect" ref={containerRef} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); containerRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } }}>
      <button type="button" aria-label={label} aria-expanded={open} className="edd-filter-select edd-multiselect-trigger" onClick={() => { setSearch(""); setOpen((current) => !current); }}>
        <span>{summary}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="edd-multiselect-panel" role="group" aria-label={label}>
          <input type="search" aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)} style={{ width: "calc(100% - 12px)", margin: 6, minHeight: 30, padding: "4px 8px", border: "1px solid #d5dfeb", borderRadius: 5 }} />
          <div className="edd-multiselect-actions">
            <button type="button" onClick={() => onChange(new Set())} disabled={!selected.size}>Clear</button>
            <button type="button" onClick={() => onChange(new Set([...selected, ...visibleOptions]))} disabled={!visibleOptions.length || visibleOptions.every(option => selected.has(option))}>{search ? "Select matches" : "Select all"}</button>
            <button type="button" onClick={() => setOpen(false)}>× Close</button>
          </div>
          {visibleOptions.map((option) => (
            <label key={option} className="edd-multiselect-option">
              <input type="checkbox" checked={selected.has(option)} onChange={() => toggle(option)} />
              {renderOption ? renderOption(option) : option}
            </label>
          ))}
          {!visibleOptions.length ? <p className="subtle" style={{ padding: "6px 10px" }}>{search ? "No matches." : "No values available."}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

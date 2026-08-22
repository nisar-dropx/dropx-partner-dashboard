"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function EddMultiSelect({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
      ? [...selected][0]
      : `${selected.size} ${label.toLowerCase()} selected`;

  return (
    <div className="edd-multiselect" ref={containerRef}>
      <button type="button" className="edd-filter-select edd-multiselect-trigger" onClick={() => setOpen((current) => !current)}>
        <span>{summary}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="edd-multiselect-panel" role="listbox" aria-label={label}>
          <div className="edd-multiselect-actions">
            <button type="button" onClick={() => onChange(new Set())} disabled={!selected.size}>Clear</button>
            <button type="button" onClick={() => onChange(new Set(options))} disabled={selected.size === options.length}>Select all</button>
          </div>
          {options.map((option) => (
            <label key={option} className="edd-multiselect-option">
              <input type="checkbox" checked={selected.has(option)} onChange={() => toggle(option)} />
              {option}
            </label>
          ))}
          {!options.length ? <p className="subtle" style={{ padding: "6px 10px" }}>No values available.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

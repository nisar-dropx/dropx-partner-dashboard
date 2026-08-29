"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type AttendanceMultiSelectProps = {
  allLabel: string;
  defaultValues?: string[];
  label: string;
  name: string;
  options: string[];
};

export function AttendanceMultiSelect({ allLabel, defaultValues = [], label, name, options }: AttendanceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(defaultValues);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.toLowerCase().includes(term));
  }, [options, query]);
  const summary = selected.length === 0
    ? allLabel
    : selected.length <= 2
      ? selected.join(", ")
      : `${selected.length} selected`;

  useEffect(() => {
    setSelected(defaultValues.filter((value) => options.includes(value)));
  }, [defaultValues.join("\u0000"), options.join("\u0000")]);

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle(value: string) {
    setSelected((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]);
  }

  return (
    <div className="attendance-multi-select multi-select" ref={rootRef}>
      {selected.map((value) => <input key={value} name={name} type="hidden" value={value} />)}
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="multi-select-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} />
      </button>
      {open ? (
        <div className="multi-select-menu attendance-multi-select-menu">
          <div className="multi-select-search">
            <Search aria-hidden="true" size={15} />
            <input
              autoFocus
              className="field multi-select-search-field"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              type="search"
              value={query}
            />
          </div>
          <label className="multi-select-all">
            <input checked={selected.length === 0} onChange={() => setSelected([])} type="checkbox" />
            <span>{allLabel}</span>
          </label>
          <div className="multi-select-options" role="listbox">
            {visibleOptions.map((option) => (
              <label className="multi-select-option" key={option}>
                <input checked={selectedSet.has(option)} onChange={() => toggle(option)} type="checkbox" />
                <span>{option}</span>
              </label>
            ))}
            {!visibleOptions.length ? <p className="attendance-multi-select-empty">No matching options</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

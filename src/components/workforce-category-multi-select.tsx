"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type WorkforceCategoryOption = {
  code: string;
  name: string;
};

export function WorkforceCategoryMultiSelect({ defaultValue = [], options }: {
  defaultValue?: string[];
  options: WorkforceCategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedCodes, setSelectedCodes] = useState(() => new Set(defaultValue));
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOptions = options.filter((option) => selectedCodes.has(option.code));
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.name} ${option.code}`.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    function closePicker(event: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, []);

  function toggle(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleAll() {
    setSelectedCodes((current) => current.size === options.length ? new Set() : new Set(options.map((option) => option.code)));
  }

  return (
    <div className="multi-select workforce-category-multi-select" ref={rootRef}>
      {selectedOptions.map((option) => <input key={option.code} name="workforce_category_codes" type="hidden" value={option.code} />)}
      <button aria-expanded={open} className={`multi-select-trigger workforce-category-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        {selectedOptions.length ? (
          <span className="workforce-category-tags">
            {selectedOptions.map((option) => (
              <span className="workforce-category-tag" key={option.code}>
                <span>{option.name}</span>
                <span
                  aria-label={`Remove ${option.name}`}
                  className="workforce-category-tag-remove"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggle(option.code);
                  }}
                  role="button"
                  tabIndex={0}
                >×</span>
              </span>
            ))}
          </span>
        ) : <span className="workforce-category-placeholder">Select workforce categories</span>}
        <span aria-hidden="true" className="multi-select-chevron">⌄</span>
      </button>
      {open ? (
        <div className="multi-select-menu workforce-category-menu">
          <div className="multi-select-search">
            <input autoFocus aria-label="Search workforce categories" className="field multi-select-search-field" onChange={(event) => setQuery(event.target.value)} placeholder="Search category name or code" type="search" value={query} />
          </div>
          <label className="multi-select-all">
            <input checked={options.length > 0 && selectedCodes.size === options.length} onChange={toggleAll} type="checkbox" />
            <span>Select all workforce categories</span>
            <small>{selectedCodes.size} selected</small>
          </label>
          <div className="multi-select-options" role="listbox">
            {visibleOptions.map((option) => (
              <label className={`multi-select-option ${selectedCodes.has(option.code) ? "selected" : ""}`} key={option.code}>
                <input checked={selectedCodes.has(option.code)} onChange={() => toggle(option.code)} type="checkbox" />
                <span><strong>{option.name}</strong><small>{option.code}</small></span>
              </label>
            ))}
            {!visibleOptions.length ? <p className="searchable-empty">No matching workforce categories.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

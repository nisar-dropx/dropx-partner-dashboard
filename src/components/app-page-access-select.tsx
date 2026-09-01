"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, LockKeyhole, X } from "lucide-react";
import { dropxOnePageOptions, requiredDropxOnePageCodes } from "@/lib/dropx-one-pages";

export const appPageOptions = dropxOnePageOptions;

export const defaultAppPageAccess = appPageOptions.map((page) => page.value);
const requiredPages = new Set<string>(requiredDropxOnePageCodes);

export function AppPageAccessSelect({
  initialPages,
  name = "app_page_access"
}: {
  initialPages: string[];
  name?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(Array.from(new Set([...initialPages, ...requiredDropxOnePageCodes])));
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = appPageOptions.every((page) => selectedSet.has(page.value));
  const someSelected = appPageOptions.some((page) => selectedSet.has(page.value));
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return appPageOptions;
    return appPageOptions.filter((page) => page.label.toLowerCase().includes(normalizedQuery));
  }, [query]);

  useEffect(() => {
    if (!open) return;

    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  function toggle(value: string) {
    if (requiredPages.has(value)) return;
    setSelected((current) => (
      current.includes(value)
        ? current.filter((page) => page !== value)
        : [...current, value]
    ));
  }

  return (
    <div className="workforce-page-select" ref={rootRef}>
      {selected.map((page) => (
        <input key={page} name={name} type="hidden" value={page} />
      ))}
      <div
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`workforce-page-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="workforce-page-tags">
          {selected.length ? selected.map((page) => {
            const label = appPageOptions.find((option) => option.value === page)?.label ?? page;
            return (
              <span className={`workforce-page-tag ${requiredPages.has(page) ? "required" : ""}`} key={page}>
                {label}
                {requiredPages.has(page) ? (
                  <span aria-label={`${label} is mandatory`} className="workforce-page-lock" role="img" title="Mandatory page">
                    <LockKeyhole aria-hidden="true" size={12} strokeWidth={2.2} />
                  </span>
                ) : (
                  <button
                    aria-label={`Remove ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(page);
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={13} strokeWidth={2.2} />
                  </button>
                )}
              </span>
            );
          }) : <span className="workforce-page-placeholder">Select app pages</span>}
        </div>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={17} strokeWidth={2.3} />
      </div>

      {open ? (
        <div className="multi-select-menu workforce-page-select-menu">
          <div className="multi-select-search">
            <input
              autoFocus
              className="field multi-select-search-field"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search app pages"
              value={query}
            />
            {selected.length ? (
              <button className="button secondary" onClick={() => setSelected([...requiredDropxOnePageCodes])} type="button">Clear optional</button>
            ) : null}
          </div>
          <label className="multi-select-all">
            <input
              checked={allSelected}
              className="matrix-checkbox"
              onChange={() => setSelected(allSelected ? [...requiredDropxOnePageCodes] : defaultAppPageAccess)}
              ref={(node) => {
                if (node) node.indeterminate = someSelected && !allSelected;
              }}
              type="checkbox"
            />
            <span><strong>Select all</strong></span>
            <small>{selected.length} of {appPageOptions.length} selected</small>
          </label>
          <div className="multi-select-options" role="listbox">
            {visibleOptions.map((page) => (
              <label className="multi-select-option" key={page.value}>
                <input
                  checked={selectedSet.has(page.value)}
                  className="matrix-checkbox"
                  disabled={requiredPages.has(page.value)}
                  onChange={() => toggle(page.value)}
                  type="checkbox"
                />
                <span><strong>{page.label}</strong>{requiredPages.has(page.value) ? <small><LockKeyhole aria-hidden="true" size={11} /> Locked · always available</small> : null}</span>
              </label>
            ))}
            {!visibleOptions.length ? <p className="searchable-empty">No pages found.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

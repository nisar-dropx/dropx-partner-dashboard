"use client";

import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type PaymentApprovalFilterOption = {
  value: string;
  label: string;
};

type MultiSelectProps = {
  allLabel: string;
  label: string;
  options: PaymentApprovalFilterOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
};

function ApprovalMultiSelect({ allLabel, label, options, selectedValues, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(selectedValues);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.label} ${option.value}`.toLowerCase().includes(term));
  }, [options, query]);
  const selectedLabels = selected
    .map((value) => options.find((option) => option.value === value)?.label)
    .filter((value): value is string => Boolean(value));
  const summary = selectedLabels.length === 0
    ? allLabel
    : selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels.length} selected`;

  useEffect(() => {
    const allowed = new Set(options.map((option) => option.value));
    setSelected(selectedValues.filter((value) => allowed.has(value)));
  }, [options, selectedValues]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function updateSelected(next: string[]) {
    setSelected(next);
    onChange(next);
  }

  function toggle(value: string) {
    updateSelected(selectedSet.has(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value]);
  }

  return (
    <div className="multi-select payment-approval-multi-select" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}: ${summary}`}
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="multi-select-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} />
      </button>
      {open ? (
        <div className="multi-select-menu payment-approval-filter-menu">
          <div className="multi-select-search payment-approval-filter-search">
            <Search aria-hidden="true" size={15} />
            <input
              autoFocus
              aria-label={`Search ${label.toLowerCase()}`}
              className="field multi-select-search-field"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              type="search"
              value={query}
            />
          </div>
          <label className="multi-select-all">
            <input checked={selected.length === 0} onChange={() => updateSelected([])} type="checkbox" />
            <span>{allLabel}</span>
          </label>
          <div className="multi-select-options" role="group" aria-label={label}>
            {visibleOptions.map((option) => (
              <label className={`multi-select-option ${selectedSet.has(option.value) ? "selected" : ""}`} key={option.value}>
                <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span>{option.label}</span>
              </label>
            ))}
            {!visibleOptions.length ? <p className="payment-approval-filter-empty">No matching options</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaymentApprovalFilters({
  search,
  status,
  stationOptions,
  paymentHeadOptions,
  dateOptions,
  selectedStations,
  selectedPaymentHeads,
  selectedDates
}: {
  search: string;
  status: string;
  stationOptions: PaymentApprovalFilterOption[];
  paymentHeadOptions: PaymentApprovalFilterOption[];
  dateOptions: PaymentApprovalFilterOption[];
  selectedStations: string[];
  selectedPaymentHeads: string[];
  selectedDates: string[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(search);
  const hasFacetFilters = selectedStations.length > 0 || selectedPaymentHeads.length > 0 || selectedDates.length > 0;

  useEffect(() => {
    setQuery(search);
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextSearch = query.trim();
      if (nextSearch === (searchParams.get("search") ?? "")) return;
      updateParams(router, pathname, searchParams, { search: nextSearch, manage: "" });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [pathname, query, router, searchParams]);

  return (
    <div className="payment-approval-filter-bar">
      <div className="payment-approval-search">
        <Search aria-hidden="true" size={16} />
        <input
          aria-label="Search approvals"
          className="field compact"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search request, location, head"
          type="search"
          value={query}
        />
      </div>
      <select
        aria-label="Approval status"
        className="field compact payment-approval-status-filter"
        name="status"
        onChange={(event) => updateParams(router, pathname, searchParams, { status: event.target.value, manage: "" })}
        value={status}
      >
        <option value="pending">Pending / Resubmitted</option>
        <option value="returned">Returned</option>
        <option value="rejected">Rejected</option>
        <option value="all">All</option>
      </select>
      <ApprovalMultiSelect
        allLabel="All stations"
        label="Stations"
        onChange={(values) => updateMultiParam(router, pathname, searchParams, "station", values)}
        options={stationOptions}
        selectedValues={selectedStations}
      />
      <ApprovalMultiSelect
        allLabel="All payment heads"
        label="Payment heads"
        onChange={(values) => updateMultiParam(router, pathname, searchParams, "head", values)}
        options={paymentHeadOptions}
        selectedValues={selectedPaymentHeads}
      />
      <ApprovalMultiSelect
        allLabel="All dates"
        label="Created dates"
        onChange={(values) => updateMultiParam(router, pathname, searchParams, "date", values)}
        options={dateOptions}
        selectedValues={selectedDates}
      />
      {hasFacetFilters ? (
        <button
          aria-label="Clear station, payment head, and date filters"
          className="button secondary compact payment-approval-clear-filters"
          onClick={() => clearFacetFilters(router, pathname, searchParams)}
          type="button"
        >
          <X aria-hidden="true" size={14} />
          Clear
        </button>
      ) : null}
    </div>
  );
}

function updateMultiParam(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  key: string,
  values: string[]
) {
  const params = new URLSearchParams(searchParams.toString());
  params.delete(key);
  values.forEach((value) => params.append(key, value));
  params.delete("manage");
  pushParams(router, pathname, searchParams, params);
}

function clearFacetFilters(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>
) {
  const params = new URLSearchParams(searchParams.toString());
  ["station", "head", "date", "manage"].forEach((key) => params.delete(key));
  pushParams(router, pathname, searchParams, params);
}

function updateParams(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  updates: Record<string, string>
) {
  const params = new URLSearchParams(searchParams.toString());
  Object.entries(updates).forEach(([key, value]) => {
    if (value) params.set(key, value);
    else params.delete(key);
  });
  pushParams(router, pathname, searchParams, params);
}

function pushParams(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  params: URLSearchParams
) {
  if (!params.get("status")) params.set("status", "pending");
  const query = params.toString();
  const nextHref = `${pathname}${query ? `?${query}` : ""}`;
  if (nextHref === `${pathname}?${searchParams.toString()}`) return;
  router.push(nextHref, { scroll: false });
}

"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type RawPunchFilterOption = {
  label: string;
  scope?: string | null;
  value: string;
};

type MultiFilterKey = "device" | "location" | "mapping";

function parseSelected(value: string | null) {
  return Array.from(new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

export function RawPunchReportFilters({
  deviceOptions,
  locationOptions
}: {
  deviceOptions: RawPunchFilterOption[];
  locationOptions: RawPunchFilterOption[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const selectedLocations = useMemo(() => parseSelected(searchParams.get("location")), [searchParams]);
  const selectedDevices = useMemo(() => parseSelected(searchParams.get("device")), [searchParams]);
  const selectedMappings = useMemo(() => parseSelected(searchParams.get("mapping")), [searchParams]);
  const visibleDeviceOptions = useMemo(() => {
    if (!selectedLocations.length) return deviceOptions;
    const locationSet = new Set(selectedLocations);
    return deviceOptions.filter((option) => option.scope && locationSet.has(option.scope));
  }, [deviceOptions, selectedLocations]);
  const mappingOptions = useMemo<RawPunchFilterOption[]>(() => [
    { value: "people", label: "Mapped in People / HR" },
    { value: "workforce", label: "Mapped in Workforce" },
    { value: "unmapped", label: "Not mapped in either" }
  ], []);

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
  }, [searchParams]);

  useEffect(() => {
    if (search.trim() === (searchParams.get("search") ?? "")) return;
    const timer = window.setTimeout(() => {
      updateParams(router, pathname, searchParams, { search: search.trim(), page: "" });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [pathname, router, search, searchParams]);

  function setFilterValues(key: MultiFilterKey, values: string[]) {
    const updates: Record<string, string> = { [key]: values.join(","), page: "" };
    if (key === "location") {
      const allowedLocations = new Set(values);
      const keptDevices = selectedDevices.filter((deviceId) => {
        const device = deviceOptions.find((option) => option.value === deviceId);
        return !values.length || Boolean(device?.scope && allowedLocations.has(device.scope));
      });
      updates.device = keptDevices.join(",");
    }
    updateParams(router, pathname, searchParams, updates);
  }

  const hasFilters = Boolean(
    search.trim() || searchParams.get("from") || searchParams.get("to") ||
    selectedLocations.length || selectedDevices.length || selectedMappings.length
  );

  return (
    <div className="event-log-filters raw-punch-report-filters">
      <label>From<input className="field" onChange={(event) => updateParams(router, pathname, searchParams, { from: event.target.value, page: "" })} type="date" value={searchParams.get("from") ?? ""} /></label>
      <label>To<input className="field" onChange={(event) => updateParams(router, pathname, searchParams, { to: event.target.value, page: "" })} type="date" value={searchParams.get("to") ?? ""} /></label>
      <MultiCheckFilter allLabel="All locations" label="Location" onChange={(values) => setFilterValues("location", values)} options={locationOptions} selected={selectedLocations} />
      <MultiCheckFilter allLabel="All devices" label="Device" onChange={(values) => setFilterValues("device", values)} options={visibleDeviceOptions} selected={selectedDevices} />
      <MultiCheckFilter allLabel="All mapping states" label="Profile mapping" onChange={(values) => setFilterValues("mapping", values)} options={mappingOptions} selected={selectedMappings} />
      <label className="event-log-search">Search<span className="raw-punch-search-wrap"><Search aria-hidden="true" size={15} /><input className="field" onChange={(event) => setSearch(event.target.value)} placeholder="Enrolment, device, terminal, transaction" value={search} /></span></label>
      <label>Rows<select className="field" onChange={(event) => updateParams(router, pathname, searchParams, { per_page: event.target.value, page: "" })} value={searchParams.get("per_page") ?? "20"}><option>20</option><option>100</option><option>500</option><option>1000</option></select></label>
      <div className="event-log-filter-actions">{hasFilters ? <button className="button secondary" onClick={() => { setSearch(""); router.replace(pathname, { scroll: false }); }} type="button">Clear</button> : null}</div>
    </div>
  );
}

function MultiCheckFilter({ allLabel, label, onChange, options, selected }: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: RawPunchFilterOption[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [localSelected, setLocalSelected] = useState(selected);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(localSelected), [localSelected]);
  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.label.toLowerCase().includes(term));
  }, [options, query]);
  const allSelected = options.length > 0 && options.every((option) => selectedSet.has(option.value));
  const summary = localSelected.length === 0
    ? allLabel
    : localSelected.length === 1
      ? options.find((option) => option.value === localSelected[0])?.label ?? "1 selected"
      : `${localSelected.length} selected`;

  useEffect(() => setLocalSelected(selected), [selected]);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  function change(values: string[]) {
    setLocalSelected(values);
    onChange(values);
  }

  return (
    <div className="verification-api-filter-field raw-punch-multi-filter" ref={rootRef}>
      <span>{label}</span>
      <button aria-expanded={open} className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((value) => !value)} type="button"><strong>{summary}</strong><ChevronDown aria-hidden="true" size={15} /></button>
      {open ? <div className="bulk-multi-filter-menu verification-api-filter-menu">
        <div className="bulk-multi-filter-search"><input autoFocus className="field" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} /></div>
        <label className="multi-select-all"><input checked={allSelected} onChange={() => change(allSelected ? [] : options.map((option) => option.value))} type="checkbox" /><span><strong>Select all</strong></span><small>{localSelected.length} of {options.length}</small></label>
        <div className="bulk-multi-filter-options">{filteredOptions.map((option) => <label className="bulk-multi-filter-option" key={option.value}><input checked={selectedSet.has(option.value)} onChange={() => change(localSelected.includes(option.value) ? localSelected.filter((item) => item !== option.value) : [...localSelected, option.value])} type="checkbox" /><span>{option.label}</span></label>)}{!filteredOptions.length ? <div className="dropdown-empty">No items found.</div> : null}</div>
      </div> : null}
    </div>
  );
}

function updateParams(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  updates: Record<string, string>
) {
  const params = new URLSearchParams(searchParams.toString());
  Object.entries(updates).forEach(([key, value]) => value ? params.set(key, value) : params.delete(key));
  const query = params.toString();
  router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
}

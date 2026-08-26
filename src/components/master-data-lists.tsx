"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { indiaStateCode, indiaStateOptions } from "@/lib/india-states";
import { StatusPill } from "./status-pill";

type ProviderRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type ModelRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  providers?: { code: string; name: string } | null;
};

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  address: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  aom: string | null;
  cluster_manager: string | null;
  cluster: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m?: number | null;
  station_email: string | null;
  station_manager_email: string | null;
  parent_station_id?: string | null;
  is_active: boolean;
  providers?: { code: string; name: string } | null;
  location_models?: { code: string; name: string } | null;
};

type SelectOption = {
  value: string;
  label: string;
  helper?: string;
  scopeValues?: string[];
};

const PAGE_SIZE = 10;
let pendingMasterDataScrollY: number | null = null;

function editHref(type: "provider" | "model" | "location", id: string) {
  const basePath = type === "provider" ? "/master/providers" : type === "model" ? "/master/models" : "/master/location";
  return `${basePath}?edit=${type}:${id}`;
}

function sameText(first: string | null | undefined, second: string | null | undefined) {
  return (first ?? "").trim().toUpperCase() === (second ?? "").trim().toUpperCase();
}

function searchMatch(values: Array<string | null | undefined>, search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return values.some((value) => (value ?? "").toLowerCase().includes(term));
}

function uniqueOptions(options: Array<{ label: string; value: string }>) {
  const seen = new Set<string>();
  return options
    .map((option) => ({
      label: option.label.trim(),
      value: option.value.trim()
    }))
    .filter((option) => {
      if (!option.value) return false;
      const key = option.value.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((first, second) => first.label.localeCompare(second.label));
}

function uniqueDetailedOptions(options: SelectOption[]) {
  const seen = new Set<string>();
  return options
    .map((option) => ({
      helper: option.helper?.trim(),
      label: option.label.trim(),
      scopeValues: option.scopeValues?.map((value) => value.trim()).filter(Boolean),
      value: option.value.trim()
    }))
    .filter((option) => {
      if (!option.value) return false;
      const key = option.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((first, second) => first.label.localeCompare(second.label));
}


function paginate<T>(rows: T[], currentPage: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const start = (page - 1) * PAGE_SIZE;

  return {
    page,
    totalPages,
    rows: rows.slice(start, start + PAGE_SIZE)
  };
}

function PaginationControls({
  currentPage,
  onPageChange,
  totalPages
}: {
  currentPage: number;
  onPageChange: (page: number) => void;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="pagination">
      <button
        className={`pager-button ${currentPage <= 1 ? "disabled" : ""}`}
        disabled={currentPage <= 1}
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        type="button"
      >
        Prev
      </button>
      <span>Page {currentPage} of {totalPages}</span>
      <button
        className={`pager-button ${currentPage >= totalPages ? "disabled" : ""}`}
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        type="button"
      >
        Next
      </button>
    </div>
  );
}

function SearchField({
  onChange,
  placeholder,
  value
}: {
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className="listing-search">
      <input
        className="field"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {value ? (
        <button className="button secondary" onClick={() => onChange("")} type="button">
          Clear
        </button>
      ) : null}
    </div>
  );
}

function EditButton({ href, label }: { href: string; label: string }) {
  const [loading, setLoading] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamString = searchParams.toString();
  const currentUrl = `${pathname}?${searchParamString}`;
  const editOpen = searchParams.has("edit");

  useEffect(() => {
    setLoading(false);
  }, [currentUrl]);

  useEffect(() => {
    if (!editOpen) return;

    const scrollY = pendingMasterDataScrollY ?? window.scrollY;
    const lockBody = () => {
      document.body.dataset.dropxScrollLock = String(scrollY);
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.width = "100%";
    };

    window.requestAnimationFrame(lockBody);
    const timeout = window.setTimeout(() => {
      lockBody();
      pendingMasterDataScrollY = null;
    }, 120);

    return () => {
      window.clearTimeout(timeout);
      const lockedScroll = Number(document.body.dataset.dropxScrollLock ?? scrollY);
      delete document.body.dataset.dropxScrollLock;
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.width = "";

      if (Number.isFinite(lockedScroll)) {
        window.scrollTo({ top: lockedScroll, left: 0, behavior: "auto" });
      }
    };
  }, [currentUrl, editOpen]);

  function handleClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    pendingMasterDataScrollY = window.scrollY;
    setLoading(true);
    event.preventDefault();
    router.push(href, { scroll: false });
  }

  return (
    <Link
      aria-label={loading ? "Opening edit" : label}
      className={`icon-button ${loading ? "loading" : ""}`}
      href={href}
      onClick={handleClick}
      onFocus={() => router.prefetch(href)}
      onMouseEnter={() => router.prefetch(href)}
      prefetch
      scroll={false}
      title={label}
    >
      {loading ? <span className="icon-spinner" aria-hidden="true" /> : <span aria-hidden="true">&#9998;</span>}
    </Link>
  );
}

function MultiCheckFilter({
  allLabel,
  label,
  onChange,
  options,
  selected
}: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: SelectOption[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.label} ${option.value}`.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    function close(event: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="bulk-multi-filter location-master-filter" ref={rootRef}>
      <button className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        <strong>{selected.length ? `${label}: ${selected.length}` : allLabel}</strong>
        <span>v</span>
      </button>
      {open ? (
        <div className="bulk-multi-filter-menu">
          <div className="bulk-multi-filter-search">
            <input className="field" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} />
          </div>
          <div className="bulk-multi-filter-options">
            <label className="bulk-multi-filter-option all">
              <input checked={!selected.length} onChange={() => onChange([])} type="checkbox" />
              <span>All</span>
            </label>
            {filteredOptions.map((option) => (
              <label className="bulk-multi-filter-option" key={option.value}>
                <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span>{option.label}</span>
                {option.helper ? <small>{option.helper}</small> : null}
              </label>
            ))}
            {!filteredOptions.length ? <div className="dropdown-empty">No items found.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MasterDataLists({
  canAdd,
  canEdit,
  locations,
  managerOptions = [],
  models,
  providers,
  sections = ["locations", "providers", "models"]
}: {
  canAdd: boolean;
  canEdit: boolean;
  locations: LocationRow[];
  managerOptions?: SelectOption[];
  models: ModelRow[];
  providers: ProviderRow[];
  sections?: Array<"locations" | "providers" | "models">;
}) {
  const showLocations = sections.includes("locations");
  const showProviders = sections.includes("providers");
  const showModels = sections.includes("models");
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [locationSearch, setLocationSearch] = useState("");
  const [locationProviders, setLocationProviders] = useState<string[]>([]);
  const [locationModels, setLocationModels] = useState<string[]>([]);
  const [locationStates, setLocationStates] = useState<string[]>([]);
  const [locationManagers, setLocationManagers] = useState<string[]>([]);
  const [isExportingLocations, setIsExportingLocations] = useState(false);
  const [providersPage, setProvidersPage] = useState(1);
  const [modelsPage, setModelsPage] = useState(1);
  const [locationsPage, setLocationsPage] = useState(1);

  const filteredProviders = useMemo(
    () => providers.filter((provider) => searchMatch([provider.code, provider.name], providerSearch)),
    [providerSearch, providers]
  );
  const filteredModels = useMemo(
    () => models.filter((model) => searchMatch([model.code, model.name, model.description, model.providers?.name, model.providers?.code], modelSearch)),
    [modelSearch, models]
  );
  const locationProviderOptions = useMemo(
    () => uniqueOptions(locations.map((location) => ({
      label: location.providers?.name || location.providers?.code || "",
      value: location.providers?.code || location.providers?.name || ""
    }))),
    [locations]
  );
  const locationModelOptions = useMemo(
    () => uniqueOptions(locations.map((location) => ({
      label: location.location_models?.code || location.location_models?.name || "",
      value: location.location_models?.code || location.location_models?.name || ""
    }))),
    [locations]
  );
  const locationStateOptions = useMemo(
    () => indiaStateOptions.map((state) => ({
      label: state.label,
      value: state.value,
      helper: state.helper
    })),
    []
  );
  const locationManagerOptions = useMemo(
    () => uniqueDetailedOptions(managerOptions),
    [managerOptions]
  );
  const filteredLocations = useMemo(
    () => locations.filter((location) => {
      const matchesProvider = !locationProviders.length || locationProviders.some((provider) => sameText(location.providers?.code || location.providers?.name, provider));
      const matchesModel = !locationModels.length || locationModels.some((model) => sameText(location.location_models?.code || location.location_models?.name, model));
      const matchesState = !locationStates.length || locationStates.some((state) => sameText(indiaStateCode(location.state), state));
      const managerScopes = locationManagers.flatMap((manager) => {
        const option = locationManagerOptions.find((item) => sameText(item.value, manager));
        return option?.scopeValues?.length ? option.scopeValues : [manager];
      });
      const matchesManager = !locationManagers.length || managerScopes.some((manager) => sameText(location.station_manager_email, manager));
      return matchesProvider && matchesModel && matchesState && matchesManager && searchMatch([
        location.station_code,
        location.station_name,
        location.address,
        location.address_line1,
        location.address_line2,
        location.city,
        location.state,
        location.region,
        location.aom,
        location.cluster_manager,
        location.postal_code,
        location.latitude?.toString(),
        location.longitude?.toString(),
        location.station_email,
        location.station_manager_email,
        location.providers?.name,
        location.providers?.code,
        location.location_models?.name,
        location.location_models?.code
      ], locationSearch);
    }),
    [locationManagerOptions, locationManagers, locationModels, locationProviders, locationSearch, locationStates, locations]
  );

  const paginatedProviders = paginate(filteredProviders, providersPage);
  const paginatedModels = paginate(filteredModels, modelsPage);
  const paginatedLocations = paginate(filteredLocations, locationsPage);

  function updateProviderSearch(value: string) {
    setProviderSearch(value);
    setProvidersPage(1);
  }

  function updateModelSearch(value: string) {
    setModelSearch(value);
    setModelsPage(1);
  }

  function updateLocationSearch(value: string) {
    setLocationSearch(value);
    setLocationsPage(1);
  }

  function updateLocationProviders(values: string[]) {
    setLocationProviders(values);
    setLocationsPage(1);
  }

  function updateLocationModels(values: string[]) {
    setLocationModels(values);
    setLocationsPage(1);
  }

  function updateLocationStates(values: string[]) {
    setLocationStates(values);
    setLocationsPage(1);
  }

  function updateLocationManagers(values: string[]) {
    setLocationManagers(values);
    setLocationsPage(1);
  }

  async function exportFilteredLocations() {
    if (!filteredLocations.length || isExportingLocations) return;
    setIsExportingLocations(true);
    try {
      const XLSX = await import("xlsx");
      const rows = filteredLocations.map((location) => ({
        "Location Code": location.station_code,
        "Location Name": location.station_name || "",
        State: indiaStateCode(location.state) || location.state || "",
        Manager: managerOptions.find((manager) => sameText(manager.value, location.station_manager_email))?.label || location.station_manager_email || "",
        Provider: location.providers?.name || location.providers?.code || "",
        Model: location.location_models?.code || location.location_models?.name || "",
        "Parent Location": location.parent_station_id
          ? locations.find((item) => item.id === location.parent_station_id)?.station_code || "Mapped"
          : "",
        "Address Line 1": location.address_line1 || location.address || "",
        "Address Line 2": location.address_line2 || "",
        City: location.city || "",
        Region: location.region || "",
        AOM: location.aom || "",
        "Cluster Manager": location.cluster_manager || "",
        "Postal Code": location.postal_code || "",
        Latitude: location.latitude,
        Longitude: location.longitude,
        "Geofence radius (m)": location.geofence_radius_m ?? "",
        "Contact Email": location.station_email || "",
        Status: location.is_active ? "Active" : "Inactive"
      }));
      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet["!cols"] = [
        { wch: 15 }, { wch: 24 }, { wch: 10 }, { wch: 28 }, { wch: 18 }, { wch: 14 },
        { wch: 18 }, { wch: 38 }, { wch: 30 }, { wch: 20 }, { wch: 18 }, { wch: 24 },
        { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 30 }, { wch: 12 }
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Locations");
      XLSX.writeFile(workbook, `locations-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setIsExportingLocations(false);
    }
  }

  return (
    <>
      {showLocations ? <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Locations</h2>
            <p className="subtle">{filteredLocations.length} of {locations.length} records. Showing 10 per page.</p>
          </div>
          <div className="listing-head-actions">
            <SearchField onChange={updateLocationSearch} placeholder="Search locations" value={locationSearch} />
            <MultiCheckFilter allLabel="All providers" label="Provider" onChange={updateLocationProviders} options={locationProviderOptions} selected={locationProviders} />
            <MultiCheckFilter allLabel="All models" label="Model" onChange={updateLocationModels} options={locationModelOptions} selected={locationModels} />
            <MultiCheckFilter allLabel="All states" label="State" onChange={updateLocationStates} options={locationStateOptions} selected={locationStates} />
            <MultiCheckFilter allLabel="All managers" label="Manager" onChange={updateLocationManagers} options={locationManagerOptions} selected={locationManagers} />
            <button
              className="button secondary"
              disabled={!filteredLocations.length || isExportingLocations}
              onClick={exportFilteredLocations}
              type="button"
            >
              Export
            </button>
            {canAdd ? <Link className="button" href="/master/location?add=location" scroll={false}>Add location</Link> : null}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Location</th>
                <th>State</th>
                <th>Manager</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Parent Location</th>
                <th>Address</th>
                <th>Contact</th>
                <th>Status</th>
                {canEdit ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {filteredLocations.length ? paginatedLocations.rows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.station_code}</strong></td>
                  <td>{row.station_name && !sameText(row.station_name, row.station_code) ? row.station_name : "-"}</td>
                  <td>{indiaStateCode(row.state) || row.state || "-"}</td>
                  <td>{managerOptions.find((manager) => sameText(manager.value, row.station_manager_email))?.label || row.station_manager_email || "-"}</td>
                  <td>{row.providers?.name || "-"}</td>
                  <td>{row.location_models?.code || "-"}</td>
                  <td>{row.parent_station_id ? locations.find((location) => location.id === row.parent_station_id)?.station_code || "Mapped" : "-"}</td>
                  <td>
                    {row.latitude !== null && row.longitude !== null ? (
                      <a
                        className="location-map-link"
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${row.latitude},${row.longitude}`)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open location in Google Maps"
                      >
                        <span>{row.address_line1 || row.address || "-"}</span>
                        {row.address_line2 ? <span>{row.address_line2}</span> : null}
                        <span className="subtle">{[row.city, row.state, row.postal_code].filter(Boolean).join(", ") || "-"}</span>
                        <span className="subtle">{row.latitude}, {row.longitude}</span>
                        <span className="subtle">Geofence: {row.geofence_radius_m != null ? `${row.geofence_radius_m} m` : "not set"}</span>
                      </a>
                    ) : (
                      <>
                        {row.address_line1 || row.address || "-"}
                        {row.address_line2 ? <><br /><span>{row.address_line2}</span></> : null}
                        <br />
                        <span className="subtle">{[row.city, row.state, row.postal_code].filter(Boolean).join(", ") || "-"}</span>
                        <br />
                        <span className="subtle">Geofence: {row.geofence_radius_m != null ? `${row.geofence_radius_m} m` : "not set"}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {row.station_email || "-"}
                  </td>
                  <td><StatusPill status={row.is_active ? "Active" : "Inactive"} /></td>
                  {canEdit ? <td className="action-cell"><EditButton href={editHref("location", row.id)} label={`Edit ${row.station_code}`} /></td> : null}
                </tr>
              )) : (
                <tr><td colSpan={canEdit ? 11 : 10} className="empty-cell">No locations found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="panel-foot">
          <PaginationControls currentPage={paginatedLocations.page} onPageChange={setLocationsPage} totalPages={paginatedLocations.totalPages} />
        </div>
      </section> : null}

      {showProviders || showModels ? <section className="grid two">
        {showProviders ? <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Providers</h2>
              <p className="subtle">{filteredProviders.length} of {providers.length} records. Showing 10 per page.</p>
            </div>
            <div className="listing-head-actions">
              <SearchField onChange={updateProviderSearch} placeholder="Search providers" value={providerSearch} />
              {canAdd ? <Link className="button" href="/master/providers?add=provider" scroll={false}>Add provider</Link> : null}
            </div>
          </div>
          <div className="table-wrap">
            <table style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Status</th>
                  {canEdit ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredProviders.length ? paginatedProviders.rows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.code}</strong></td>
                    <td>{row.name}</td>
                    <td><StatusPill status={row.is_active ? "Active" : "Inactive"} /></td>
                    {canEdit ? <td className="action-cell"><EditButton href={editHref("provider", row.id)} label={`Edit ${row.name}`} /></td> : null}
                  </tr>
                )) : (
                  <tr><td colSpan={canEdit ? 4 : 3} className="empty-cell">No providers found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">
            <PaginationControls currentPage={paginatedProviders.page} onPageChange={setProvidersPage} totalPages={paginatedProviders.totalPages} />
          </div>
        </div> : null}

        {showModels ? <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Models</h2>
              <p className="subtle">{filteredModels.length} of {models.length} records. Showing 10 per page.</p>
            </div>
            <div className="listing-head-actions">
              <SearchField onChange={updateModelSearch} placeholder="Search models" value={modelSearch} />
              {canAdd ? <Link className="button" href="/master/models?add=model" scroll={false}>Add model</Link> : null}
            </div>
          </div>
          <div className="table-wrap">
            <table style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Provider</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Status</th>
                  {canEdit ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredModels.length ? paginatedModels.rows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.code}</strong></td>
                    <td>{row.providers?.name || "-"}</td>
                    <td>{row.name}</td>
                    <td>{row.description || "-"}</td>
                    <td><StatusPill status={row.is_active ? "Active" : "Inactive"} /></td>
                    {canEdit ? <td className="action-cell"><EditButton href={editHref("model", row.id)} label={`Edit ${row.code}`} /></td> : null}
                  </tr>
                )) : (
                  <tr><td colSpan={canEdit ? 6 : 5} className="empty-cell">No models found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">
            <PaginationControls currentPage={paginatedModels.page} onPageChange={setModelsPage} totalPages={paginatedModels.totalPages} />
          </div>
        </div> : null}
      </section> : null}

    </>
  );
}

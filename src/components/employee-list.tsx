"use client";
import { ReportTable } from "@/components/report-table";


import { useEffect, useMemo, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { EmployeeActionMenu } from "@/components/employee-action-menu";
import { StatusPill } from "@/components/status-pill";
import { formatDashboardDate } from "@/lib/date-format";

export type EmployeeListRow = {
  id: string;
  employeeCode: string;
  biometricId: string;
  fullName: string;
  mobile: string;
  email: string;
  dateOfJoin: string;
  location: string;
  provider: string;
  model: string;
  designation: string;
  statutory: string;
  status: string;
  profilePhotoUrl?: string | null;
  canEdit?: boolean;
};

type FilterOption = {
  value: string;
  label: string;
};

const pageSize = 20;

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter((value) => value && value !== "-")))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
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
  options: FilterOption[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.label.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="bulk-multi-filter field-executive-filter" ref={rootRef}>
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
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EmployeeList({
  canEdit,
  rows
}: {
  canEdit: boolean;
  rows: EmployeeListRow[];
}) {
  const [search, setSearch] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [statutory, setStatutory] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const providerOptions = useMemo(() => uniqueOptions(rows.map((row) => row.provider)), [rows]);
  const modelOptions = useMemo(() => uniqueOptions(rows.map((row) => row.model)), [rows]);
  const locationOptions = useMemo(() => uniqueOptions(rows.map((row) => row.location)), [rows]);
  const designationOptions = useMemo(() => uniqueOptions(rows.map((row) => row.designation)), [rows]);
  const statutoryOptions = useMemo(() => uniqueOptions(rows.map((row) => row.statutory)), [rows]);
  const statusOptions = useMemo(() => uniqueOptions(rows.map((row) => row.status)), [rows]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const searchable = `${row.employeeCode} ${row.biometricId} ${row.fullName} ${row.mobile} ${row.email} ${row.dateOfJoin} ${row.provider} ${row.model} ${row.location} ${row.designation} ${row.statutory} ${row.status}`.toLowerCase();
      return (!term || searchable.includes(term))
        && (!providers.length || providers.includes(row.provider))
        && (!models.length || models.includes(row.model))
        && (!locations.length || locations.includes(row.location))
        && (!designations.length || designations.includes(row.designation))
        && (!statutory.length || statutory.includes(row.statutory))
        && (!statuses.length || statuses.includes(row.status));
    });
  }, [designations, locations, models, providers, rows, search, statuses, statutory]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function updateFilter(setter: (values: string[]) => void, values: string[]) {
    setter(values);
    setPage(1);
  }

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>Employee register</h2>
          <p className="subtle">{filteredRows.length} of {rows.length} records</p>
        </div>
        <div className="field-executive-filters">
          <MultiCheckFilter allLabel="All providers" label="Provider" onChange={(values) => updateFilter(setProviders, values)} options={providerOptions} selected={providers} />
          <MultiCheckFilter allLabel="All models" label="Model" onChange={(values) => updateFilter(setModels, values)} options={modelOptions} selected={models} />
          <MultiCheckFilter allLabel="All locations" label="Location" onChange={(values) => updateFilter(setLocations, values)} options={locationOptions} selected={locations} />
          <MultiCheckFilter allLabel="All designations" label="Designation" onChange={(values) => updateFilter(setDesignations, values)} options={designationOptions} selected={designations} />
          <MultiCheckFilter allLabel="All statutory" label="Statutory" onChange={(values) => updateFilter(setStatutory, values)} options={statutoryOptions} selected={statutory} />
          <MultiCheckFilter allLabel="All statuses" label="Status" onChange={(values) => updateFilter(setStatuses, values)} options={statusOptions} selected={statuses} />
          <input
            className="field field-executive-search"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search ID, biometric ID, name, mobile, email"
            value={search}
          />
        </div>
      </div>
      <div className="table-wrap field-executive-table-wrap employee-table-wrap">
        <ReportTable>
          <thead>
            <tr>
              <th>Emp ID</th>
              <th>Full name</th>
              <th>Biometric ID</th>
              <th>Mobile</th>
              <th>Email</th>
              <th>Date of join</th>
              <th>Location</th>
              <th>Designation</th>
              <th>Statutory</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? visibleRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="executive-name-cell">
                    <span className="executive-avatar" aria-hidden="true">
                      {row.profilePhotoUrl ? <img alt="" src={row.profilePhotoUrl} /> : <UserRound size={17} />}
                    </span>
                    <strong>{row.employeeCode}</strong>
                  </div>
                </td>
                <td><strong>{row.fullName}</strong></td>
                <td>{row.biometricId}</td>
                <td>{row.mobile}</td>
                <td>{row.email}</td>
                <td>{formatDashboardDate(row.dateOfJoin)}</td>
                <td>{row.location}</td>
                <td>{row.designation}</td>
                <td>{row.statutory}</td>
                <td><StatusPill status={row.status} /></td>
                <td className="action-cell">
                  <EmployeeActionMenu canEdit={canEdit && row.canEdit !== false} employeeId={row.id} fullName={row.fullName} />
                </td>
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={11}>No employees match the selected filters.</td></tr>
            )}
          </tbody>
        </ReportTable>
      </div>
      {totalPages > 1 ? (
        <div className="panel-foot pagination">
          <button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
    </section>
  );
}

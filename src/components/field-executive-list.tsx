"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EllipsisVertical, Eye, Pencil, UserRound } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";

export type FieldExecutiveListRow = {
  id: string;
  dropxId: string;
  biometricId: string;
  fullName: string;
  mobile: string;
  email: string;
  location: string;
  provider: string;
  model: string;
  designation: string;
  profilePhotoUrl?: string | null;
  isActive: boolean;
  status: string;
  canEdit?: boolean;
};

const pageSize = 20;

type FilterOption = {
  value: string;
  label: string;
  helper?: string;
};

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
    return options.filter((option) => !term || `${option.label} ${option.helper ?? ""}`.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
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
                {option.helper ? <small>{option.helper}</small> : null}
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FieldExecutiveList({
  basePath = "/workforce",
  canEdit,
  emptyLabel = "No field executives added yet.",
  rows,
  showActions = true,
  title = "Field Executive register"
}: {
  basePath?: string;
  canEdit: boolean;
  emptyLabel?: string;
  rows: FieldExecutiveListRow[];
  showActions?: boolean;
  title?: string;
}) {
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [designationFilter, setDesignationFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenuId) return;

    function closeMenu(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenuId(null);
    }

    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);
  const providerOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.provider).filter((value) => value && value !== "-")))
      .sort((left, right) => left.localeCompare(right))
      .map((provider) => ({ value: provider, label: provider }))
  ), [rows]);
  const locationOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.location).filter((value) => value && value !== "-")))
      .sort((left, right) => left.localeCompare(right))
      .map((location) => ({ value: location, label: location }))
  ), [rows]);
  const modelOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.model).filter((value) => value && value !== "-")))
      .sort((left, right) => left.localeCompare(right))
      .map((model) => ({ value: model, label: model }))
  ), [rows]);
  const designationOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.designation).filter((value) => value && value !== "-")))
      .sort((left, right) => left.localeCompare(right))
      .map((designation) => ({ value: designation, label: designation }))
  ), [rows]);
  const statusOptions = useMemo(() => (
    Array.from(new Set(rows.map((row) => row.status).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right))
      .map((status) => ({ value: status.toLowerCase(), label: status }))
  ), [rows]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const selectedStatuses = new Set(statusFilter);
    return rows.filter((row) => {
      const matchesSearch = !term || (
        `${row.dropxId} ${row.biometricId} ${row.fullName} ${row.mobile} ${row.email} ${row.location} ${row.provider} ${row.model} ${row.designation}`
          .toLowerCase()
          .includes(term)
      );
      const matchesProvider = !providerFilter.length || providerFilter.includes(row.provider);
      const matchesModel = !modelFilter.length || modelFilter.includes(row.model);
      const matchesLocation = !locationFilter.length || locationFilter.includes(row.location);
      const matchesDesignation = !designationFilter.length || designationFilter.includes(row.designation);
      const matchesStatus = !statusFilter.length || selectedStatuses.has(row.status.toLowerCase());

      return matchesSearch && matchesProvider && matchesModel && matchesLocation && matchesDesignation && matchesStatus;
    });
  }, [designationFilter, locationFilter, modelFilter, providerFilter, rows, search, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>{title}</h2>
          <p className="subtle">{filteredRows.length} of {rows.length} records</p>
        </div>
        <div className="field-executive-filters">
          <MultiCheckFilter
            allLabel="All providers"
            label="Provider"
            onChange={(values) => {
              setProviderFilter(values);
              setPage(1);
            }}
            options={providerOptions}
            selected={providerFilter}
          />
          <MultiCheckFilter
            allLabel="All locations"
            label="Location"
            onChange={(values) => {
              setLocationFilter(values);
              setPage(1);
            }}
            options={locationOptions}
            selected={locationFilter}
          />
          <MultiCheckFilter
            allLabel="All models"
            label="Model"
            onChange={(values) => {
              setModelFilter(values);
              setPage(1);
            }}
            options={modelOptions}
            selected={modelFilter}
          />
          <MultiCheckFilter
            allLabel="All designations"
            label="Designation"
            onChange={(values) => {
              setDesignationFilter(values);
              setPage(1);
            }}
            options={designationOptions}
            selected={designationFilter}
          />
          <MultiCheckFilter
            allLabel="All statuses"
            label="Status"
            onChange={(values) => {
              setStatusFilter(values);
              setPage(1);
            }}
            options={statusOptions}
            selected={statusFilter}
          />
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
      <div className={`table-wrap field-executive-table-wrap ${openMenuId ? "menu-open" : ""}`}>
        <table>
          <thead>
            <tr>
              <th>Full name</th>
              <th>ID</th>
              <th>Biometric ID</th>
              <th>Mobile</th>
              <th>Email</th>
              <th>Location</th>
              <th>Designation</th>
              <th>Status</th>
              {showActions ? <th>Action</th> : null}
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
                    <strong>{row.fullName}</strong>
                  </div>
                </td>
                <td>{row.dropxId}</td>
                <td>{row.biometricId}</td>
                <td>{row.mobile}</td>
                <td>{row.email}</td>
                <td>{row.location}</td>
                <td>{row.designation}</td>
                <td><StatusPill status={row.status} /></td>
                {showActions ? <td className="action-cell">
                  <div className="row-action-menu" ref={openMenuId === row.id ? menuRef : undefined}>
                    <button
                      aria-expanded={openMenuId === row.id}
                      aria-haspopup="menu"
                      aria-label={`Actions for ${row.fullName}`}
                      className="icon-button"
                      onClick={() => setOpenMenuId((current) => current === row.id ? null : row.id)}
                      type="button"
                    >
                      <EllipsisVertical size={17} aria-hidden="true" />
                    </button>
                    {openMenuId === row.id ? (
                      <div className="row-action-popover">
                        <PendingLink className="row-action-item" href={`${basePath}?view=${row.id}`} scroll={false}>
                          <Eye size={15} aria-hidden="true" /> View
                        </PendingLink>
                        {canEdit && row.canEdit !== false ? (
                          <PendingLink className="row-action-item" href={`${basePath}?edit=${row.id}`} scroll={false}>
                            <Pencil size={15} aria-hidden="true" /> Edit
                          </PendingLink>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </td> : null}
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={showActions ? 9 : 8}>{emptyLabel}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <div className="panel-foot pagination">
          <button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, EllipsisVertical, Eye, Pencil, Search, X } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { allPeopleExportColumns, type AllPeopleExportKey, type AllPeopleExportValues } from "@/lib/all-people-export";

export type AllPeopleRow = {
  id: string;
  category: string;
  categoryCode: string;
  code: string;
  biometricId: string;
  fullName: string;
  mobile: string;
  email: string;
  location: string;
  designation: string;
  status: string;
  viewHref?: string;
  editHref?: string;
  canEdit: boolean;
  exportValues: AllPeopleExportValues;
};

const rowsPerPage = 20;

type FilterOption = { value: string; label: string };

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
    <div className="bulk-multi-filter all-people-filter" ref={rootRef}>
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

function optionsFrom(values: string[]) {
  return Array.from(new Set(values.filter((value) => value && value !== "-")))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
}

function AllPeopleActionMenu({ row }: { row: AllPeopleRow }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const tableWrap = menuRef.current?.closest(".employee-table-wrap");
    tableWrap?.classList.add("menu-open");
    function closeMenu(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      tableWrap?.classList.remove("menu-open");
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!row.viewHref) return null;

  return (
    <div className="row-action-menu" ref={menuRef}>
      <button aria-expanded={open} aria-haspopup="menu" aria-label={`Actions for ${row.fullName}`} className="icon-button" onClick={() => setOpen((current) => !current)} type="button">
        <EllipsisVertical aria-hidden="true" size={17} />
      </button>
      {open ? (
        <div className="row-action-popover">
          <PendingLink className="row-action-item" href={row.viewHref}>
            <Eye aria-hidden="true" size={15} /> View
          </PendingLink>
          {row.canEdit && row.editHref ? (
            <PendingLink className="row-action-item" href={row.editHref}>
              <Pencil aria-hidden="true" size={15} /> Edit
            </PendingLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AllPeopleRegister({ rows }: { rows: AllPeopleRow[] }) {
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportColumnSearch, setExportColumnSearch] = useState("");
  const [selectedExportColumns, setSelectedExportColumns] = useState<AllPeopleExportKey[]>(() => allPeopleExportColumns.map((column) => column.key));

  const categoryOptions = useMemo(() => (
    Array.from(new Map(rows.map((row) => [row.categoryCode, row.category])).entries())
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label }))
  ), [rows]);
  const locationOptions = useMemo(() => optionsFrom(rows.map((row) => row.location)), [rows]);
  const designationOptions = useMemo(() => optionsFrom(rows.map((row) => row.designation)), [rows]);
  const statusOptions = useMemo(() => optionsFrom(rows.map((row) => row.status)), [rows]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (categories.length && !categories.includes(row.categoryCode)) return false;
      if (locations.length && !locations.includes(row.location)) return false;
      if (designations.length && !designations.includes(row.designation)) return false;
      if (statuses.length && !statuses.includes(row.status)) return false;
      return !term || `${row.code} ${row.biometricId} ${row.fullName} ${row.mobile} ${row.email} ${row.location} ${row.designation} ${row.category}`.toLowerCase().includes(term);
    });
  }, [categories, designations, locations, rows, search, statuses]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

  useEffect(() => setPage(1), [categories, designations, locations, search, statuses]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const selectedExportSet = useMemo(() => new Set(selectedExportColumns), [selectedExportColumns]);
  const visibleExportColumns = useMemo(() => {
    const term = exportColumnSearch.trim().toLowerCase();
    return allPeopleExportColumns.filter((column) => !term || column.label.toLowerCase().includes(term));
  }, [exportColumnSearch]);

  function toggleExportColumn(key: AllPeopleExportKey) {
    setSelectedExportColumns((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  async function exportPeople() {
    if (!selectedExportColumns.length || !filteredRows.length) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const columns = allPeopleExportColumns.filter((column) => selectedExportSet.has(column.key));
      const data = [
        columns.map((column) => column.label),
        ...filteredRows.map((row) => columns.map((column) => row.exportValues[column.key] ?? ""))
      ];
      const worksheet = XLSX.utils.aoa_to_sheet(data);

      // Excel must receive identifiers as text or it removes leading zeroes and rounds values over 15 digits.
      for (let rowIndex = 1; rowIndex < data.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          const cell = worksheet[address];
          if (cell) {
            cell.t = "s";
            cell.v = String(data[rowIndex][columnIndex] ?? "");
            cell.z = "@";
          }
        }
      }
      worksheet["!cols"] = columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.label.length + 3)) }));
      worksheet["!autofilter"] = { ref: worksheet["!ref"] ?? "A1:A1" };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "All People");
      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `all-people-${date}.xlsx`, { compression: true });
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>People register</h2>
          <p className="subtle">{filteredRows.length} of {rows.length} records</p>
        </div>
        <div className="all-people-filters">
          <input className="field all-people-search" onChange={(event) => setSearch(event.target.value)} placeholder="Search ID, name, mobile, email" value={search} />
          <MultiCheckFilter allLabel="All categories" label="Category" onChange={setCategories} options={categoryOptions} selected={categories} />
          <MultiCheckFilter allLabel="All locations" label="Location" onChange={setLocations} options={locationOptions} selected={locations} />
          <MultiCheckFilter allLabel="All designations" label="Designation" onChange={setDesignations} options={designationOptions} selected={designations} />
          <MultiCheckFilter allLabel="All statuses" label="Status" onChange={setStatuses} options={statusOptions} selected={statuses} />
          <button className="button secondary all-people-export-trigger" disabled={!filteredRows.length} onClick={() => {
            setExportColumnSearch("");
            setExportOpen(true);
          }} type="button">
            <Download aria-hidden="true" size={16} /> Export
          </button>
        </div>
      </div>
      <div className="table-wrap field-executive-table-wrap employee-table-wrap all-people-table-wrap">
        <table>
          <thead><tr><th>DropX ID</th><th>Biometric ID</th><th>Full name</th><th>Category</th><th>Mobile</th><th>Email</th><th>Location</th><th>Designation</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.categoryCode}:${row.id}`}>
                <td><strong>{row.code}</strong></td><td>{row.biometricId}</td><td><strong>{row.fullName}</strong></td>
                <td>{row.category}</td><td>{row.mobile}</td><td>{row.email}</td><td>{row.location}</td><td>{row.designation}</td>
                <td><StatusPill status={row.status} /></td>
                <td><AllPeopleActionMenu row={row} /></td>
              </tr>
            ))}
            {!filteredRows.length ? <tr><td className="empty-cell" colSpan={10}>No people match the selected filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {filteredRows.length ? (
        <div className="panel-foot pagination">
          <button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
      {exportOpen ? (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !exporting) setExportOpen(false);
        }}>
          <section aria-labelledby="all-people-export-title" aria-modal="true" className="modal-panel all-people-export-dialog" role="dialog">
            <div className="panel-head">
              <div>
                <h2 id="all-people-export-title">Export people</h2>
                <p className="subtle">Choose the Excel columns. All titles are selected by default.</p>
              </div>
              <button aria-label="Close export" className="icon-button" disabled={exporting} onClick={() => setExportOpen(false)} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <div className="all-people-export-body">
              <div className="all-people-export-toolbar">
                <label className="all-people-export-select-all">
                  <input
                    checked={selectedExportColumns.length === allPeopleExportColumns.length}
                    onChange={(event) => setSelectedExportColumns(event.target.checked ? allPeopleExportColumns.map((column) => column.key) : [])}
                    type="checkbox"
                  />
                  <strong>Select all titles</strong>
                </label>
                <span className="subtle">{filteredRows.length} filtered record{filteredRows.length === 1 ? "" : "s"}</span>
              </div>
              <label className="all-people-export-search">
                <Search aria-hidden="true" size={17} />
                <input
                  autoComplete="off"
                  className="field"
                  onChange={(event) => setExportColumnSearch(event.target.value)}
                  placeholder="Search titles"
                  type="search"
                  value={exportColumnSearch}
                />
              </label>
              <div className="all-people-export-columns">
                {visibleExportColumns.map((column) => (
                  <label key={column.key}>
                    <input checked={selectedExportSet.has(column.key)} onChange={() => toggleExportColumn(column.key)} type="checkbox" />
                    <span>{column.label}</span>
                  </label>
                ))}
                {!visibleExportColumns.length ? (
                  <p className="all-people-export-empty subtle">No titles match your search.</p>
                ) : null}
              </div>
            </div>
            <div className="all-people-export-actions">
              <button className="button secondary" disabled={exporting} onClick={() => setExportOpen(false)} type="button">Cancel</button>
              <button className="button" disabled={exporting || !selectedExportColumns.length || !filteredRows.length} onClick={exportPeople} type="button">
                <Download aria-hidden="true" size={16} /> {exporting ? "Preparing..." : "Export Excel"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

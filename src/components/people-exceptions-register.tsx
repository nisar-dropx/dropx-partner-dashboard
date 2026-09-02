"use client";

import { useMemo, useState } from "react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";

export type PeopleExceptionListRow = {
  key: string; dropxId: string; name: string; category: string; designation: string;
  location: string; issue: string; detail: string; clearHref: string;
};

function MultiFilter({ label, values, selected, setSelected }: { label: string; values: string[]; selected: string[]; setSelected: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = values.filter((value) => value.toLowerCase().includes(query.toLowerCase()));
  const toggle = (value: string) => setSelected(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  return <div className="bulk-multi-filter all-people-filter">
    <button className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen(!open)} type="button"><strong>{selected.length ? `${label}: ${selected.length}` : `All ${label.toLowerCase()}s`}</strong><span>v</span></button>
    {open ? <div className="bulk-multi-filter-menu"><div className="bulk-multi-filter-search"><input autoFocus className="field" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} /></div><div className="bulk-multi-filter-options"><label className="bulk-multi-filter-option all"><input checked={!selected.length} onChange={() => setSelected([])} type="checkbox" /><span>All</span></label>{visible.map((value) => <label className="bulk-multi-filter-option" key={value}><input checked={selected.includes(value)} onChange={() => toggle(value)} type="checkbox" /><span>{value}</span></label>)}</div></div> : null}
  </div>;
}

export function PeopleExceptionsRegister({ rows }: { rows: PeopleExceptionListRow[] }) {
  const [search, setSearch] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const options = (key: keyof PeopleExceptionListRow) => Array.from(new Set(rows.map((row) => String(row[key])).filter((value) => value && value !== "-"))).sort();
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => (!term || [row.dropxId, row.name, row.location, row.designation, row.issue].some((value) => value.toLowerCase().includes(term))) && (!locations.length || locations.includes(row.location)) && (!categories.length || categories.includes(row.category)) && (!designations.length || designations.includes(row.designation)) && (!issues.length || issues.includes(row.issue)));
  }, [rows, search, locations, categories, designations, issues]);
  return <section className="panel"><div className="panel-head"><div><h2>Open exceptions</h2><p className="subtle">Active profiles only. Partial matches remain in Under Review.</p></div></div><div className="table-tools"><input className="field" onChange={(event) => setSearch(event.target.value)} placeholder="Search ID, person, location, designation" value={search} /><MultiFilter label="Location" selected={locations} setSelected={setLocations} values={options("location")} /><MultiFilter label="Category" selected={categories} setSelected={setCategories} values={options("category")} /><MultiFilter label="Designation" selected={designations} setSelected={setDesignations} values={options("designation")} /><MultiFilter label="Exception type" selected={issues} setSelected={setIssues} values={options("issue")} /></div><div className="table-wrap"><table><thead><tr><th>DropX ID</th><th>Person</th><th>Category</th><th>Designation</th><th>Location</th><th>Exception</th><th>Details</th><th>Action</th></tr></thead><tbody>{filtered.length ? filtered.map((row) => <tr key={row.key}><td><strong>{row.dropxId}</strong></td><td><strong>{row.name}</strong></td><td>{row.category}</td><td>{row.designation}</td><td>{row.location}</td><td><StatusPill status={row.issue} /></td><td>{row.detail}</td><td><PendingLink className="button secondary compact" href={row.clearHref} scroll={false}>Clear</PendingLink></td></tr>) : <tr><td className="empty-cell" colSpan={8}>No matching open exceptions.</td></tr>}</tbody></table></div><div className="panel-body"><span className="subtle">{filtered.length} of {rows.length} open exceptions</span></div></section>;
}

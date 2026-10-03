"use client";

import { useMemo, useState } from "react";
import { PendingLink } from "@/components/pending-link";
import type { RegistrationProgress } from "@/lib/workforce-registration-progress";

export type PendingRegistrationRow = {
  id: string; fullName: string; mobile: string; location: string; designation: string;
  status: string; savedAt?: string | null; canEdit: boolean; progress: RegistrationProgress;
};

export function OpsPendingRegistrations({ rows }: { rows: PendingRegistrationRow[] }) {
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("");
  const [page, setPage] = useState(1);
  const locations = useMemo(() => [...new Set(rows.map(row => row.location))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter(row => (!location || row.location === location)
    && `${row.fullName} ${row.mobile} ${row.location}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, search, location]);
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages);
  return <section className="panel ops-pending-registrations">
    <div className="panel-head toolbar">
      <div><h2>Pending registrations</h2><p className="subtle">{filtered.length} pending · Open an associate to see saved registration progress.</p></div>
      <div className="ops-registration-filters">
        <select className="field" aria-label="Filter pending registrations by station" value={location} onChange={event => { setLocation(event.target.value); setPage(1); }}>
          <option value="">All stations</option>{locations.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <input className="field" aria-label="Search pending registrations" placeholder="Search name or mobile" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
      </div>
    </div>
    <div className="ops-registration-list">
      {filtered.slice((currentPage - 1) * 20, currentPage * 20).map(row => <details className="ops-registration-row" key={row.id}>
        <summary>
          <span className="ops-registration-person"><strong>{row.fullName}</strong><small>{row.mobile}</small></span>
          <span>{row.location}<small>{row.designation}</small></span>
          <span className="ops-registration-progress"><strong>{row.status}</strong><small>{row.progress.total ? `${row.progress.filled} of ${row.progress.total} details filled` : "Registration not submitted"}</small></span>
          <span className="ops-registration-expand">View progress <span aria-hidden="true">⌄</span></span>
        </summary>
        <div className="ops-registration-detail">
          <p className="subtle">{row.savedAt ? `Last saved ${new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(row.savedAt))}` : "No in-app draft saved yet."} · Filled details are not a submitted registration.</p>
          <div className="ops-registration-sections">{row.progress.groups.map(group => <div key={group.name}>
            <strong>{group.name}<span>{group.filled}/{group.total}</span></strong>
            <progress aria-label={`${group.name} details filled for ${row.fullName}`} max={group.total} value={group.filled} />
            <small>{group.missing.length ? `Still needed: ${group.missing.join(", ")}` : "Required details filled"}</small>
          </div>)}</div>
          <div className="ops-registration-next"><p>{row.progress.missingRequired ? `${row.progress.missingRequired} required details remaining. Ask the associate to complete registration in DropX One.` : "Ask the associate to review and submit registration in DropX One."}</p>
            {row.canEdit ? <PendingLink className="button secondary" href={`/work-force-register?edit=${row.id}`} scroll={false}>Edit request</PendingLink> : null}
          </div>
        </div>
      </details>)}
      {!filtered.length ? <p className="empty-cell">No pending registrations{search || location ? " match these filters" : " in your locations"}.</p> : null}
    </div>
    {pages > 1 ? <div className="panel-foot pagination"><button className="pager-button" type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {pages}</span><button className="pager-button" type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div> : null}
  </section>;
}

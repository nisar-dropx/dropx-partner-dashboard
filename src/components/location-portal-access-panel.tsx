"use client";

import { useMemo, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";

export type LocationPortalAccessProduct = {
  code: string;
  label: string;
};

export type LocationPortalAccessRow = {
  locationId: string;
  code: string;
  name: string;
  email: string | null;
  profileId: string | null;
  enabledProducts: string[];
};

const PAGE_SIZE = 10;

export function LocationPortalAccessPanel({
  canEdit,
  products,
  rows,
  saveAction
}: {
  canEdit: boolean;
  products: readonly LocationPortalAccessProduct[];
  rows: LocationPortalAccessRow[];
  saveAction: (formData: FormData) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => [row.code, row.name, row.email].some((value) => String(value ?? "").toLowerCase().includes(normalized)));
  }, [query, rows]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return <section className="panel">
    <div className="panel-head toolbar">
      <div>
        <h2>Location portal access</h2>
        <p className="subtle">Dashboard owns station mailboxes and decides which portals each location can open. Menu permissions remain controlled inside each portal.</p>
      </div>
      <a className="button secondary" href="/master/location">Location Master</a>
    </div>
    <div className="panel-body">
      <input
        aria-label="Search locations"
        className="field"
        onChange={(event) => { setQuery(event.target.value); setPage(1); }}
        placeholder="Search station code, name, or DropX email"
        value={query}
      />
    </div>
    <div className="table-wrap">
      <table style={{ minWidth: 1080 }}>
        <thead><tr><th>Location</th><th>DropX mailbox</th>{products.map((product) => <th key={product.code}>{product.label}</th>)}<th>Action</th></tr></thead>
        <tbody>
          {visibleRows.map((row) => {
            const canSave = canEdit && Boolean(row.profileId && row.email);
            return <tr key={row.locationId}>
              <td><strong>{row.code}</strong><div className="subtle">{row.name}</div></td>
              <td>{row.email ? <><strong>{row.email}</strong><div className="subtle">{row.profileId ? "Identity linked" : "Save this mailbox in Location Master to link it"}</div></> : <StatusPill status="Mailbox required" />}</td>
              <td colSpan={products.length + 1} style={{ padding: 0 }}>
                <form action={saveAction} style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: `repeat(${products.length}, minmax(110px, 1fr)) 110px`, padding: "12px 16px" }}>
                  <input name="location_id" type="hidden" value={row.locationId} />
                  {products.map((product) => <label className="check-row" key={product.code} style={{ margin: 0 }}>
                    <input defaultChecked={row.enabledProducts.includes(product.code)} disabled={!canSave} name="product_codes" type="checkbox" value={product.code} />
                    <span>{row.enabledProducts.includes(product.code) ? "Enabled" : "Off"}</span>
                  </label>)}
                  {canSave ? <SubmitButton className="button secondary" pendingText="Saving…">Save</SubmitButton> : <span className="subtle">Setup required</span>}
                </form>
              </td>
            </tr>;
          })}
          {!visibleRows.length ? <tr><td className="empty-cell" colSpan={products.length + 3}>No matching active location was found.</td></tr> : null}
        </tbody>
      </table>
    </div>
    {totalPages > 1 ? <div className="pagination"><button className="pager-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button><span>Page {currentPage} of {totalPages}</span><button className="pager-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></div> : null}
  </section>;
}

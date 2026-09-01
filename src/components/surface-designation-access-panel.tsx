"use client";

import { useState } from "react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";

export type SurfaceDesignationAccessRow = {
  designationId: string;
  code: string;
  name: string;
  enabled: boolean;
  roleId: string | null;
  locationAccessMode: "all_locations" | "role_based" | null;
  permissionSummary: string;
};

const PAGE_SIZE = 12;

export function SurfaceDesignationAccessPanel({
  canEdit,
  configureAction,
  masterHref,
  productCode,
  rows,
  title
}: {
  canEdit: boolean;
  configureAction: (formData: FormData) => void | Promise<void>;
  masterHref: string;
  productCode: string;
  rows: SurfaceDesignationAccessRow[];
  title: string;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return <section className="panel">
    <div className="panel-head toolbar"><div><h2>{title}</h2><p className="subtle">Every active People designation is visible. Eligibility comes from People; menus and actions are configured here.</p></div><a className="button secondary" href={masterHref}>Designation Master</a></div>
    <div className="table-wrap"><table style={{ minWidth: 860 }}><thead><tr><th>Designation code</th><th>Designation</th><th>Portal eligibility</th><th>Location access</th><th>Menu permissions</th><th>Action</th></tr></thead><tbody>
      {pagedRows.map((row) => <tr key={row.designationId}>
        <td><strong>{row.code}</strong></td><td>{row.name}</td>
        <td><StatusPill status={!row.enabled ? "Not enabled" : row.roleId ? "Configured" : "Setup required"} /></td>
        <td>{row.roleId ? row.locationAccessMode === "all_locations" ? "All locations" : "Person-managed locations" : "—"}</td>
        <td>{row.permissionSummary}</td>
        <td>{!canEdit ? "—" : !row.enabled ? <a className="button secondary" href={`${masterHref}?search=${encodeURIComponent(row.code)}`}>Enable in People</a> : row.roleId ? <PendingLink className="button secondary" href={`/users?section=roles&editRole=${row.roleId}`} scroll={false}>Manage</PendingLink> : <form action={configureAction}><input name="designation_id" type="hidden" value={row.designationId} /><input name="product_code" type="hidden" value={productCode} /><SubmitButton className="button secondary" pendingText="Preparing…">Set up</SubmitButton></form>}</td>
      </tr>)}
      {!pagedRows.length ? <tr><td className="empty-cell" colSpan={6}>No active People designation is available.</td></tr> : null}
    </tbody></table></div>
    {totalPages > 1 ? <div className="pagination"><button className="pager-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button><span>Page {currentPage} of {totalPages}</span><button className="pager-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></div> : null}
  </section>;
}

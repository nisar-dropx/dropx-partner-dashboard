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
  locationAccount,
  configureLocationAction,
  productCode,
  rows,
  title
}: {
  canEdit: boolean;
  configureAction: (formData: FormData) => void | Promise<void>;
  masterHref: string;
  locationAccount: { roleId: string | null; permissionSummary: string };
  configureLocationAction: (formData: FormData) => void | Promise<void>;
  productCode: string;
  rows: SurfaceDesignationAccessRow[];
  title: string;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return <section className="panel">
    <div className="panel-head toolbar"><div><h2>{title}</h2><p className="subtle">Only People designations enabled for this portal appear here. Configure the menus and actions; People remains the source of the designation and person scope.</p></div><a className="button secondary" href={masterHref}>Designation Master</a></div>
    <div className="panel-head"><div><h3>Location Account</h3><p className="subtle">Station mailbox eligibility is granted only from the main Dashboard. Configure here which {title.replace(" designation access", "")} menus those mailboxes can use.</p></div></div>
    <div className="table-wrap"><table style={{ minWidth: 860 }}><thead><tr><th>Account type</th><th>Portal status</th><th>Location scope</th><th>Menu permissions</th><th>Action</th></tr></thead><tbody><tr>
      <td><strong>Location Account</strong><div className="subtle">One shared DropX mailbox per station or station group</div></td>
      <td><StatusPill status={locationAccount.roleId ? "Configured" : "Setup required"} /></td>
      <td>Dashboard-managed locations</td>
      <td>{locationAccount.permissionSummary}</td>
      <td>{!canEdit ? "—" : locationAccount.roleId ? <PendingLink className="button secondary" href={`/users?section=roles&editRole=${locationAccount.roleId}`} scroll={false}>Configure menus</PendingLink> : <form action={configureLocationAction}><input name="product_code" type="hidden" value={productCode} /><SubmitButton className="button secondary" pendingText="Preparing…">Set up menus</SubmitButton></form>}</td>
    </tr></tbody></table></div>
    <div className="panel-head" style={{ borderTop: "1px solid var(--border)" }}><div><h3>People designations</h3><p className="subtle">Only designations enabled for this portal are listed below.</p></div></div>
    <div className="table-wrap"><table style={{ minWidth: 860 }}><thead><tr><th>Designation</th><th>Portal status</th><th>Location scope</th><th>Menu permissions</th><th>Action</th></tr></thead><tbody>
      {pagedRows.map((row) => <tr key={row.designationId}>
        <td><strong>{row.name}</strong><div className="subtle">{row.code}</div></td>
        <td><StatusPill status={row.roleId ? "Configured" : "Setup required"} /></td>
        <td>{row.roleId ? row.locationAccessMode === "all_locations" ? "All locations" : "Person-managed locations" : "—"}</td>
        <td>{row.permissionSummary}</td>
        <td>{!canEdit ? "—" : row.roleId ? <PendingLink className="button secondary" href={`/users?section=roles&editRole=${row.roleId}`} scroll={false}>Configure menus</PendingLink> : <form action={configureAction}><input name="designation_id" type="hidden" value={row.designationId} /><input name="product_code" type="hidden" value={productCode} /><SubmitButton className="button secondary" pendingText="Preparing…">Set up menus</SubmitButton></form>}</td>
      </tr>)}
      {!pagedRows.length ? <tr><td className="empty-cell" colSpan={5}>No People designation is enabled for this portal. Enable one in People Designation Master.</td></tr> : null}
    </tbody></table></div>
    {totalPages > 1 ? <div className="pagination"><button className="pager-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button><span>Page {currentPage} of {totalPages}</span><button className="pager-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></div> : null}
  </section>;
}

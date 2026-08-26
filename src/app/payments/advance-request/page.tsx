import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { approveAdvanceRequest, rejectAdvanceRequest } from "./actions";

type AdvanceRequestRow = {
  id: string;
  profile_type: string;
  account_code: string | null;
  requester_name: string | null;
  station_code: string | null;
  designation: string | null;
  amount: number;
  purpose: string;
  status: string;
  approved_amount: number | null;
  decision_comment: string | null;
  requested_at: string;
  updated_at: string;
};

const openStatuses = new Set(["submitted", "in_review"]);

function profileLabel(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function statusLabel(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export const dynamic = "force-dynamic";

export default async function AdvanceRequestPage({
  searchParams
}: {
  searchParams?: { status?: string; manage?: string; error?: string; notice?: string };
}) {
  const authorization = await requirePagePermission("advance_requests", "access");
  if (!isCompanyOwner(authorization)) redirect("/unauthorized?page=advance_requests&action=owner");
  const companyId = requireCompanyId(authorization);
  const status = ["pending", "approved", "rejected", "all"].includes(searchParams?.status ?? "")
    ? searchParams?.status ?? "pending"
    : "pending";

  let requests: AdvanceRequestRow[] = [];
  let error: string | null = null;
  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    let query = supabaseAdmin
      .from("payment_advance_requests")
      .select("id, profile_type, account_code, requester_name, station_code, designation, amount, purpose, status, approved_amount, decision_comment, requested_at, updated_at")
      .eq("company_id", companyId)
      .order("requested_at", { ascending: false });
    if (status === "pending") query = query.in("status", ["submitted", "in_review"]);
    if (status === "approved" || status === "rejected") query = query.eq("status", status);
    const result = await query;
    requests = (result.data ?? []) as AdvanceRequestRow[];
    error = result.error?.message ?? null;
  }

  const selectedRequest = searchParams?.manage
    ? requests.find((request) => request.id === searchParams.manage) ?? null
    : null;
  const baseParams = new URLSearchParams(status === "pending" ? {} : { status });

  return (
    <AppShell active="Advance Request" pageCode="advance_requests">
      <PageHead
        eyebrow="Payments"
        title="Advance Request"
        subtitle="Review workforce advance requests and approve or reject them."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Advance requests unavailable</strong><p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_advance_requests_v1.sql` in Supabase SQL Editor, then refresh.</p></div></section> : null}
      {searchParams?.error || searchParams?.notice ? <section className={`panel message-panel ${searchParams.error ? "error" : "success"}`}><div className="panel-body"><strong>{searchParams.error ? "Request not updated" : "Request updated"}</strong><p className="subtle" style={{ marginTop: 6 }}>{searchParams.error ?? searchParams.notice}</p></div></section> : null}

      {!error ? <section className="panel">
        <div className="panel-head">
          <div><h2>Advance requests</h2><p className="subtle">{requests.length} records</p></div>
          <div className="button-row">
            {["pending", "approved", "rejected", "all"].map((filter) => <PendingLink key={filter} className={`button compact ${status === filter ? "" : "secondary"}`} href={`/payments/advance-request${filter === "pending" ? "" : `?status=${filter}`}`}>{filter.charAt(0).toUpperCase() + filter.slice(1)}</PendingLink>)}
          </div>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Requester</th><th>Type</th><th>Station</th><th>Amount</th><th>Purpose</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead>
          <tbody>{requests.length ? requests.map((request) => <tr key={request.id}>
            <td><strong>{request.requester_name || request.account_code || "-"}</strong>{request.requester_name && request.account_code ? <div className="subtle">{request.account_code}</div> : null}</td>
            <td>{profileLabel(request.profile_type)}{request.designation ? <div className="subtle">{request.designation}</div> : null}</td>
            <td>{request.station_code || "-"}</td><td>Rs {Number(request.amount).toLocaleString("en-IN")}</td><td>{request.purpose}</td>
            <td><StatusPill status={statusLabel(request.status)} /></td><td>{formatDashboardDateTime(request.requested_at)}</td>
            <td><PendingLink className="button secondary compact" href={`/payments/advance-request?${new URLSearchParams({ ...Object.fromEntries(baseParams), manage: request.id }).toString()}`} scroll={false}>{openStatuses.has(request.status) ? "Review" : "View"}</PendingLink></td>
          </tr>) : <tr><td className="empty-cell" colSpan={8}>No advance requests found.</td></tr>}</tbody>
        </table></div>
      </section> : null}

      {selectedRequest ? <div className="modal-backdrop"><section className="modal-panel wide" aria-label="Review advance request">
        <div className="panel-head"><div><h2>Advance request</h2><p className="subtle">{selectedRequest.requester_name || selectedRequest.account_code || "Requester"}</p></div><PendingLink className="icon-button" href={`/payments/advance-request${baseParams.size ? `?${baseParams}` : ""}`} scroll={false} aria-label="Close">x</PendingLink></div>
        <div className="panel-body">
          <div className="form-grid three">
            <label>Requester<input className="field" readOnly value={selectedRequest.requester_name || "-"} /></label>
            <label>Account ID<input className="field" readOnly value={selectedRequest.account_code || "-"} /></label>
            <label>Station<input className="field" readOnly value={selectedRequest.station_code || "-"} /></label>
            <label>Profile type<input className="field" readOnly value={profileLabel(selectedRequest.profile_type)} /></label>
            <label>Designation<input className="field" readOnly value={selectedRequest.designation || "-"} /></label>
            <label>Requested amount<input className="field" readOnly value={`Rs ${Number(selectedRequest.amount).toLocaleString("en-IN")}`} /></label>
          </div>
          <label style={{ display: "grid", gap: 8, marginTop: 16 }}>Purpose<textarea className="field" readOnly rows={4} value={selectedRequest.purpose} /></label>
          {openStatuses.has(selectedRequest.status) ? <form className="payment-approval-action-form" style={{ marginTop: 20 }}>
            <input name="requestId" type="hidden" value={selectedRequest.id} />
            <label>Approved amount<input className="field" defaultValue={selectedRequest.amount} min="0.01" name="approvedAmount" step="0.01" type="number" /></label>
            <label>Decision comment<textarea className="field" maxLength={500} name="comment" placeholder="Required when rejecting" rows={3} /></label>
            <div className="payment-approval-action-buttons"><button className="button payment-approve-button" formAction={approveAdvanceRequest}>Approve</button><button className="button danger" formAction={rejectAdvanceRequest}>Reject</button></div>
          </form> : <div style={{ marginTop: 20 }}><StatusPill status={statusLabel(selectedRequest.status)} />{selectedRequest.approved_amount != null ? <p>Approved amount: <strong>Rs {Number(selectedRequest.approved_amount).toLocaleString("en-IN")}</strong></p> : null}{selectedRequest.decision_comment ? <p className="subtle">{selectedRequest.decision_comment}</p> : null}</div>}
        </div>
      </section></div> : null}
    </AppShell>
  );
}

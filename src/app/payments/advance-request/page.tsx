import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { approveAdvanceRequest, rejectAdvanceRequest } from "./actions";

type AdvanceRequestRow = {
  id: string;
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

function statusLabel(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export const dynamic = "force-dynamic";

export default async function AdvanceRequestPage({
  searchParams
}: {
  searchParams?: { status?: string; error?: string; notice?: string };
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
      .select("id, account_code, requester_name, station_code, designation, amount, purpose, status, approved_amount, decision_comment, requested_at, updated_at")
      .eq("company_id", companyId)
      .order("requested_at", { ascending: false });
    if (status === "pending") query = query.in("status", ["submitted", "in_review"]);
    if (status === "approved" || status === "rejected") query = query.eq("status", status);
    const result = await query;
    requests = (result.data ?? []) as AdvanceRequestRow[];
    error = result.error?.message ?? null;
  }

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
            {["pending", "approved", "rejected", "all"].map((filter) => <a key={filter} className={`button compact ${status === filter ? "" : "secondary"}`} href={`/payments/advance-request${filter === "pending" ? "" : `?status=${filter}`}`}>{filter.charAt(0).toUpperCase() + filter.slice(1)}</a>)}
          </div>
        </div>
        <div className="table-wrap"><table className="advance-request-table"><thead><tr><th>Requester</th><th>Designation</th><th>Station</th><th>Requested Amt</th><th>Purpose</th><th>Status</th><th>Requested</th><th>Approved Amt</th><th>Remarks</th><th>Action</th></tr></thead>
          <tbody>{requests.length ? requests.map((request) => <tr key={request.id}>
            <td><strong>{request.requester_name || request.account_code || "-"}</strong>{request.requester_name && request.account_code ? <div className="subtle">{request.account_code}</div> : null}</td>
            <td>{request.designation || "-"}</td>
            <td>{request.station_code || "-"}</td><td>Rs {Number(request.amount).toLocaleString("en-IN")}</td><td>{request.purpose}</td>
            <td><StatusPill status={statusLabel(request.status)} /></td><td>{formatDashboardDateTime(request.requested_at)}</td>
            {openStatuses.has(request.status) ? <>
              <td colSpan={3} className="advance-request-inline-cell"><form className="advance-request-inline-form">
                <input name="requestId" type="hidden" value={request.id} />
                <input aria-label={`Approved amount for ${request.requester_name || request.account_code || "request"}`} className="field" defaultValue={request.amount} min="0.01" name="approvedAmount" placeholder="Approved amt" step="0.01" type="number" />
                <input aria-label={`Remarks for ${request.requester_name || request.account_code || "request"}`} className="field" maxLength={500} name="comment" placeholder="Remarks (required to reject)" />
                <div className="advance-request-inline-actions"><button className="button compact payment-approve-button" formAction={approveAdvanceRequest}>Approve</button><button className="button compact danger" formAction={rejectAdvanceRequest}>Reject</button></div>
              </form></td>
            </> : <><td>{request.approved_amount == null ? "-" : `Rs ${Number(request.approved_amount).toLocaleString("en-IN")}`}</td><td>{request.decision_comment || "-"}</td><td>-</td></>}
          </tr>) : <tr><td className="empty-cell" colSpan={10}>No advance requests found.</td></tr>}</tbody>
        </table></div>
      </section> : null}
    </AppShell>
  );
}

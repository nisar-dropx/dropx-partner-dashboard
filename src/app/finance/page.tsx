import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PaymentRow = {
  id: string;
  amount: number | null;
  amount_requested: number | null;
  status: string | null;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  payment_mode: string | null;
  payment_portal: string | null;
  payment_reference: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
  created_at: string | null;
  processed_at: string | null;
};

const terminalApprovalStatuses = new Set(["RE_APPROVED", "REJECTED", "RETURNED", "CANCELLED", "PROCESSING", "PROCESSED"]);

function statusOf(row: PaymentRow) {
  return String(row.approval_status || row.status || "").trim().toUpperCase();
}

function hasCurrentApprover(row: PaymentRow) {
  return Boolean(row.current_approver_user_id || row.current_approver_role_id || row.current_approver_role_ids?.length);
}

function isFinalApproved(row: PaymentRow) {
  const status = statusOf(row);
  return !hasCurrentApprover(row) && (status === "APPROVED" || status === "OWNER_APPROVED" || status === "RE_APPROVED" || status.endsWith("_APPROVED"));
}

function hasPaymentDetails(row: PaymentRow) {
  if (row.amount == null && row.amount_requested == null) return false;
  const mode = String(row.payment_mode || "account_transfer").trim().toUpperCase();
  if (mode === "ONLINE" || mode === "ONLINE_PAYMENT") return Boolean(row.payment_portal?.trim());
  if (mode === "UPI" || mode === "UPI_PAYMENT") return Boolean(row.payment_reference?.trim());
  return Boolean(row.bank_account_no?.trim() && row.ifsc?.trim() && row.account_holder_name?.trim());
}

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export const dynamic = "force-dynamic";

export default async function FinanceDashboardPage() {
  const authorization = await requirePagePermission("payments", "access");
  const companyId = requireCompanyId(authorization);
  const result = supabaseAdmin
    ? await supabaseAdmin
      .from("payment_requests")
      .select("id, amount, amount_requested, status, approval_status, current_approver_user_id, current_approver_role_id, current_approver_role_ids, payment_mode, payment_portal, payment_reference, bank_account_no, ifsc, account_holder_name, created_at, processed_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(5000)
    : { data: null, error: { message: "Supabase service role key is not configured." } };
  const rows = (result.data ?? []) as PaymentRow[];
  const pendingApproval = rows.filter((row) => {
    const status = statusOf(row);
    return !terminalApprovalStatuses.has(status) && (hasCurrentApprover(row) || status === "PENDING" || !status);
  });
  const missingDetails = rows.filter((row) => isFinalApproved(row) && !hasPaymentDetails(row));
  const readyToProcess = rows.filter((row) => isFinalApproved(row) && hasPaymentDetails(row) && statusOf(row) !== "PROCESSED");
  const processing = rows.filter((row) => statusOf(row) === "PROCESSING");
  const returned = rows.filter((row) => ["RETURNED", "REJECTED"].includes(statusOf(row)));
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const processedThisMonth = rows.filter((row) => statusOf(row) === "PROCESSED" && row.processed_at && new Date(row.processed_at) >= monthStart);
  const processedAmount = processedThisMonth.reduce((total, row) => total + Number(row.amount ?? row.amount_requested ?? 0), 0);

  const actions = [
    { code: "payment_approvals", label: "Awaiting approval", count: pendingApproval.length, detail: "Requests still inside the approval chain", href: "/payments/approvals", tone: pendingApproval.length ? "warn" : "good" },
    { code: "payment_process", label: "Ready to process", count: readyToProcess.length, detail: "Fully approved requests with payment details", href: "/payments/process", tone: readyToProcess.length ? "warn" : "good" },
    { code: "payment_process", label: "Missing payment details", count: missingDetails.length, detail: "Approved, but blocked by beneficiary or mode details", href: "/payments/process", tone: missingDetails.length ? "bad" : "good" },
    { code: "payment_process", label: "Bank processing", count: processing.length, detail: "Payments started but not marked processed", href: "/payments/process", tone: processing.length ? "warn" : "good" },
    { code: "payment_reports", label: "Returned or rejected", count: returned.length, detail: "Requests needing correction or review", href: "/payments/report", tone: returned.length ? "bad" : "good" },
    { code: "workforce_payouts", label: "Workforce payouts", count: null, detail: "Review production-backed payout rows", href: "/payments/workforce-payouts", tone: "neutral" }
  ].filter((item) => hasPermission(authorization, item.code, "access"));
  const adminLinks = [
    { code: "master_payment_heads", label: "Payment heads", href: "/master/payment-heads" },
    { code: "payment_methods", label: "Payment methods", href: "/master/payment-methods" },
    { code: "master_payment_banks", label: "Payment banks", href: "/master/payment-banks" },
    { code: "payment_settings", label: "Finance settings", href: "/settings/payments" },
    { code: "users", label: "Finance users", href: "/users?section=users" },
    { code: "users", label: "Finance designation access", href: "/users?section=roles" }
  ].filter((item) => hasPermission(authorization, item.code, "access"));

  return (
    <AppShell active="Finance Dashboard" pageCode="payments">
      <PageHead
        eyebrow="Finance control"
        title="Finance action centre"
        subtitle="Prioritise approvals, resolve payment blockers and monitor processing without changing the Ops payment-request workflow."
        action={hasPermission(authorization, "payment_process", "access") ? <Link className="button" href="/payments/process">Open payment process</Link> : null}
      />

      {result.error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load Finance actions</strong><p className="subtle">{result.error.message}</p></div></section> : null}

      <section className="summary-grid">
        <div className="metric-card"><span>Open approvals</span><strong>{pendingApproval.length}</strong><small>Across active requests</small></div>
        <div className="metric-card"><span>Ready for payment</span><strong>{readyToProcess.length}</strong><small>Approved and complete</small></div>
        <div className="metric-card"><span>Payment blockers</span><strong>{missingDetails.length + returned.length}</strong><small>Missing details, returned or rejected</small></div>
        <div className="metric-card"><span>Processed this month</span><strong>{money(processedAmount)}</strong><small>{processedThisMonth.length} payment{processedThisMonth.length === 1 ? "" : "s"}</small></div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Actions requiring attention</h2><p className="subtle">Only actions allowed by the current Finance role are shown.</p></div></div>
        <div className="finance-action-grid">
          {actions.map((item) => (
            <Link className={`finance-action-card ${item.tone}`} href={item.href} key={item.label}>
              <div><strong>{item.label}</strong><p>{item.detail}</p></div>
              <span>{item.count == null ? "Open" : item.count}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Finance administration</h2><p className="subtle">Payment heads, methods, banks, contacts, settings, users and Finance roles are owned here.</p></div></div>
        <div className="panel-body finance-admin-links">
          {adminLinks.map((item) => <Link className="button secondary" href={item.href} key={`${item.href}-${item.label}`}>{item.label}</Link>)}
        </div>
      </section>
    </AppShell>
  );
}

import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { loadPayAdvanceWorkerContexts, type PayAdvanceWorkerContext } from "@/lib/pay-advance-payment-context";
import { formatApplyingMonth, formatWorkingDays, workerCodeFromDetails } from "@/lib/pay-advance-worker-facts";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PayAdvancePaymentRow = {
  id: string;
  request_no: string;
  location_code: string | null;
  requested_for_name: string | null;
  amount: number | null;
  status: string | null;
  approval_status: string | null;
  created_at: string;
  work_date: string | null;
  source_type: string | null;
  source_id: string | null;
  details: { worker_code?: string | null } | null;
};

function money(value: number | null | undefined) {
  if (value == null) return "—";
  return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function paymentStatus(row: PayAdvancePaymentRow) {
  const approval = String(row.approval_status ?? "").toUpperCase();
  const status = String(row.status ?? "").toUpperCase();
  if (approval === "PROCESSED" || status === "PROCESSED" || status === "PAID") return "Paid";
  if (approval === "PROCESSING" || status === "PROCESSING") return "Processing";
  if (approval === "REJECTED" || status === "REJECTED") return "Rejected";
  return "Waiting for payment";
}

export const dynamic = "force-dynamic";

export default async function PayAdvanceRegisterPage() {
  const authorization = await requirePagePermission("payment_process", "access");
  const companyId = requireCompanyId(authorization);
  let rows: PayAdvancePaymentRow[] = [];
  let error: string | null = null;
  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    const result = await supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_code, requested_for_name, amount, status, approval_status, created_at, work_date, source_type, source_id, details")
      .eq("company_id", companyId)
      .or("source_type.eq.pay_advance,category.eq.pay_advance")
      .order("created_at", { ascending: false });
    rows = (result.data ?? []) as PayAdvancePaymentRow[];
    error = result.error?.message ?? null;
  }
  let contexts = new Map<string, PayAdvanceWorkerContext>();
  if (!error) {
    try {
      contexts = await loadPayAdvanceWorkerContexts(companyId, rows.map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        sourceType: row.source_type ?? "pay_advance",
        requestedForName: row.requested_for_name,
        workerCode: workerCodeFromDetails(row.details),
        createdAt: row.created_at,
        workDate: row.work_date
      })));
    } catch {
      contexts = new Map();
    }
  }

  return (
    <AppShell active="Pay Advances" pageCode="payment_process">
      <PageHead
        eyebrow="Payments"
        title="Pay Advances"
        subtitle="Salary advances approved in People and sent here for payment. The same register is on the dashboard and fin.dropxlogistics.com. Paying one debits it on that month’s payroll."
      />
      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Pay advance register unavailable</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div></section> : null}
      {!error ? <section className="panel">
        <div className="panel-head"><div><h2>Pay advance register</h2><p className="subtle">{rows.length} records · open Process to pay one</p></div><a className="button secondary" href="/payments/process">Open payment process</a></div>
        <div className="table-wrap"><table><thead><tr><th>Person</th><th>ID</th><th>Station</th><th>Applying month</th><th>Working days</th><th>Monthly CTC</th><th>Monthly gross</th><th>Advance</th><th>Payment</th><th>Request</th><th>Sent</th></tr></thead>
          <tbody>{rows.length ? rows.map((row) => {
            const context = contexts.get(row.id);
            return <tr key={row.id}>
              <td><strong>{context?.name ?? row.requested_for_name ?? "—"}</strong></td>
              <td>{context?.workerCode ?? workerCodeFromDetails(row.details) ?? "—"}</td>
              <td>{row.location_code ?? "—"}</td>
              <td>{context ? formatApplyingMonth(context.applyingMonth) : "—"}</td>
              <td>{context ? formatWorkingDays(context.workingDays) : "—"}</td>
              <td>{money(context?.monthlyCtc)}</td>
              <td>{money(context?.monthlyGross)}</td>
              <td>{money(row.amount)}</td>
              <td><StatusPill status={paymentStatus(row)} /></td>
              <td>{row.request_no}</td>
              <td>{formatDashboardDateTime(row.created_at)}</td>
            </tr>;
          }) : <tr><td className="empty-cell" colSpan={11}>No pay advance has been sent to Payments.</td></tr>}</tbody>
        </table></div>
      </section> : null}
    </AppShell>
  );
}


import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { loadPayAdvanceWorkerContexts, type PayAdvanceWorkerContext } from "@/lib/pay-advance-payment-context";
import { formatApplyingMonth, formatWorkingDays } from "@/lib/pay-advance-worker-facts";
import { loadPaidAdvanceRegister, type PaidAdvanceRegisterRow } from "@/lib/paid-advance-register";
import { supabaseAdmin } from "@/lib/supabase-admin";

function money(value: number | null | undefined) {
  if (value == null) return "—";
  return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export const dynamic = "force-dynamic";

export default async function PayAdvanceRegisterPage() {
  const authorization = await requirePagePermission("payment_process", "access");
  const companyId = requireCompanyId(authorization);
  let rows: PaidAdvanceRegisterRow[] = [];
  let error: string | null = null;
  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    try {
      rows = await loadPaidAdvanceRegister(supabaseAdmin, companyId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to load paid advances.";
    }
  }
  let contexts = new Map<string, PayAdvanceWorkerContext>();
  if (!error) {
    try {
      contexts = await loadPayAdvanceWorkerContexts(companyId, rows.map((row) => ({
        id: row.id,
        sourceId: row.request_id,
        sourceType: "pay_advance",
        requestedForName: row.name,
        workerCode: row.worker_code,
        createdAt: row.paid_at,
        workDate: row.first_due_period
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
        subtitle="Paid advances for HRMS and Workforce, including recorded historical payments. Unpaid requests are shown in Payment Process."
      />
      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Pay advance register unavailable</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div></section> : null}
      {!error ? <section className="panel">
        <div className="panel-head"><div><h2>Paid advance register</h2><p className="subtle">{rows.length} paid records</p></div><a className="button secondary" href="/payments/process">Open payment process</a></div>
        <div className="table-wrap"><ReportTable><thead><tr><th>Person</th><th>ID</th><th>Station</th><th>Recovery month</th><th>Working days</th><th>Monthly CTC</th><th>Monthly gross</th><th>Advance</th><th>Payment</th><th>Reference</th><th>Paid on</th></tr></thead>
          <tbody>{rows.length ? rows.map((row) => {
            const context = contexts.get(row.id);
            return <tr key={row.id}>
              <td><strong>{context?.name ?? row.name}</strong></td>
              <td>{row.worker_code ?? "—"}</td>
              <td>{row.station}</td>
              <td>{formatApplyingMonth(row.first_due_period)}</td>
              <td>{context?.applyingMonth === row.first_due_period ? formatWorkingDays(context.workingDays) : "—"}</td>
              <td>{money(context?.applyingMonth === row.first_due_period ? context.monthlyCtc : null)}</td>
              <td>{money(context?.applyingMonth === row.first_due_period ? context.monthlyGross : null)}</td>
              <td>{money(row.amount)}</td>
              <td><StatusPill status="Paid" /></td>
              <td>{String(row.provenance?.request_number ?? row.bank_reference ?? `ADV-${row.id.slice(0, 8)}`)}</td>
              <td>{formatDashboardDateTime(row.paid_at)}</td>
            </tr>;
          }) : <tr><td className="empty-cell" colSpan={11}>No paid advance has been recorded.</td></tr>}</tbody>
        </ReportTable></div>
      </section> : null}
    </AppShell>
  );
}

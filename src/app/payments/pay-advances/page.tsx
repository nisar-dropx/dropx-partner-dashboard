import { applyPayoutDeductionsToAdvanceRegister } from "@/lib/advance-register-payout-deductions";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { WorkforceAdvanceRegister, type WorkforceAdvanceRegisterRow } from "@/components/workforce-advance-register";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPaidAdvanceRegisterView } from "@/lib/paid-advance-register";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export default async function PayAdvanceRegisterPage() {
  const authorization = await requirePagePermission("payment_process", "access");
  const companyId = requireCompanyId(authorization);
  let rows: WorkforceAdvanceRegisterRow[] = [];
  let error: string | null = null;
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    rows = await loadPaidAdvanceRegisterView(supabaseAdmin, companyId);
    rows = await applyPayoutDeductionsToAdvanceRegister(supabaseAdmin, companyId, rows, (from, to, ids) => loadWorkforcePayoutRows(companyId, authorization, from, to, { workforceIds: ids }));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Unable to load paid advances.";
  }
  return <AppShell active="Pay Advances" pageCode="payment_process">
    <PageHead eyebrow="Payments" title="Pay Advances"
      subtitle="Bank-confirmed advances and historical paid advances for HRMS and Workforce, with payroll recovery. Unpaid requests are shown in Payment Process." />
    {error
      ? <section className="panel message-panel error"><div className="panel-body"><strong>Pay advance register unavailable</strong><p className="subtle">{error}</p></div></section>
      : <WorkforceAdvanceRegister canAdd={false} canEdit={false} rows={rows} workforceOptions={[]} personLabel="Person" exportPrefix="pay-advances"
          registerDescription="Paid advances for HRMS and Workforce. Deducted includes recoveries already recorded or included in payout deductions. Pending is the remaining amount not yet included. Unregistered IDs remain visible until registration links them for payroll recovery." />}
  </AppShell>;
}

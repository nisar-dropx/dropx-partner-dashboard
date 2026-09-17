import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

type PaymentHeadRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

async function loadPaymentHeads(companyId: string) {
  if (!supabaseAdmin) return { heads: [] as PaymentHeadRow[], stepCounts: new Map<string, number>(), error: "Supabase service role key is not configured." };
  const [headsResult, stepsResult] = await Promise.all([
    supabaseAdmin.from("payment_heads").select("id, code, name, is_active").eq("company_id", companyId).order("name"),
    supabaseAdmin.from("payment_head_approval_steps").select("payment_head_id").eq("company_id", companyId)
  ]);
  const error = headsResult.error?.message || stepsResult.error?.message || null;
  const stepCounts = new Map<string, number>();
  for (const row of stepsResult.data ?? []) {
    stepCounts.set(row.payment_head_id, (stepCounts.get(row.payment_head_id) ?? 0) + 1);
  }
  return { heads: (headsResult.data ?? []) as PaymentHeadRow[], stepCounts, error };
}

export const dynamic = "force-dynamic";

export default async function PaymentApprovalsSettingsPage() {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const { heads, stepCounts, error } = await loadPaymentHeads(companyId);

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Payment Approval Steps"
        subtitle="Configure the ordered approval chain per payment head - who approves first, who's next if they're unavailable, and where it escalates."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Payment heads</h2>
            <p className="subtle">Select a payment head to configure its approval steps.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Payment Head</th>
                <th>Code</th>
                <th>Approval Steps</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {heads.length ? heads.map((head) => {
                const stepCount = stepCounts.get(head.id) ?? 0;
                return (
                  <tr key={head.id}>
                    <td><strong>{head.name}</strong>{head.is_active ? null : <><br /><span className="subtle">Inactive</span></>}</td>
                    <td>{head.code}</td>
                    <td>{stepCount ? `${stepCount} step${stepCount === 1 ? "" : "s"} configured` : "Not configured yet - falls back to legacy roles"}</td>
                    <td><PendingLink className="button secondary compact" href={`/settings/payment-approvals/${head.id}`}>Configure</PendingLink></td>
                  </tr>
                );
              }) : (
                <tr><td className="empty-cell" colSpan={4}>No payment heads found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

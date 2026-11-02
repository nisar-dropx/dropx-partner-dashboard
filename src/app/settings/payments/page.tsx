
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { savePaymentApprovalFlow } from "./actions";

type RoleRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type FlowRow = {
  id: string;
  step_order: number;
  role_id: string;
  is_final: boolean;
  user_roles?: { code: string; name: string } | { code: string; name: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function loadPaymentSettings(companyId: string) {
  if (!supabaseAdmin) return { roles: [] as RoleRow[], flows: [] as FlowRow[], error: "Supabase service role key is not configured." };
  const [rolesResult, flowsResult] = await Promise.all([
    supabaseAdmin
      .from("user_roles")
      .select("id, code, name, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabaseAdmin
      .from("payment_approval_flows")
      .select("id, step_order, role_id, is_final, user_roles (code, name)")
      .eq("company_id", companyId)
      .order("step_order")
  ]);
  const error = rolesResult.error?.message || flowsResult.error?.message || null;
  return {
    roles: (rolesResult.data ?? []) as RoleRow[],
    flows: ((flowsResult.data ?? []) as FlowRow[]).map((flow) => ({ ...flow, user_roles: firstRelation(flow.user_roles) })),
    error
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentSettingsPage() {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_settings;
  const { roles, flows, error } = await loadPaymentSettings(companyId);
  const roleOptions = roles.map((role) => ({ value: role.id, label: role.name, helper: role.code }));
  const stepSlots = Array.from({ length: Math.max(5, flows.length + 1) }, (_, index) => flows[index] ?? null);

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Payment Settings"
        subtitle="Configure approval flow for location expense payment requests."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Payment approvals</h2>
            <p className="subtle">Select roles in order, from the first approver to the final approver.</p>
          </div>
        </div>
        <form action={savePaymentApprovalFlow} className="panel-body">
          <input type="hidden" name="step_count" value={stepSlots.length} />
          <div className="form-grid two">
            {stepSlots.map((flow, index) => (
              <label key={flow?.id ?? `step-${index}`}>
                {index === 0 ? "Starting user role" : index === stepSlots.length - 1 ? "Final user role" : `Approval step ${index + 1}`}
                <SearchableSelect
                  disabled={!pagePermission.canEdit}
                  name={`steps[${index}][role_id]`}
                  options={roleOptions}
                  defaultValue={flow?.role_id ?? ""}
                  placeholder="Select role"
                />
              </label>
            ))}
          </div>
          {pagePermission.canEdit ? (
            <div className="form-actions">
              <SubmitButton>Save approval flow</SubmitButton>
            </div>
          ) : null}
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Current approval flow</h2>
            <p className="subtle">{flows.length ? `${flows.length} step${flows.length === 1 ? "" : "s"} configured` : "No approval flow configured yet."}</p>
          </div>
        </div>
        <div className="table-wrap">
          <ReportTable>
            <thead>
              <tr>
                <th>Step</th>
                <th>User Role</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {flows.length ? flows.map((flow) => {
                const role = firstRelation(flow.user_roles);
                return (
                  <tr key={flow.id}>
                    <td>{flow.step_order}</td>
                    <td><strong>{role?.name ?? "-"}</strong><br /><span className="subtle">{role?.code ?? ""}</span></td>
                    <td>{flow.is_final ? "Final approval" : "Approval"}</td>
                  </tr>
                );
              }) : (
                <tr><td className="empty-cell" colSpan={3}>No payment approval flow added yet.</td></tr>
              )}
            </tbody>
          </ReportTable>
        </div>
      </section>
    </AppShell>
  );
}

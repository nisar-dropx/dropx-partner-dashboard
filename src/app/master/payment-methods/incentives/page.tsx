
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { updateIncentivePlanStatus } from "./actions";
import { IncentivePlanForm } from "./incentive-plan-form";

export const dynamic = "force-dynamic";

function attendanceSummary(plan: any) {
  const requirements = [
    plan.attendance_required === false ? null : plan.attendance_threshold_type === "maximum_absent_days"
      ? `max ${plan.maximum_absent_days} absent`
      : `min ${plan.minimum_present_days} present`,
    plan.reporting_time_required === false ? null : `by ${String(plan.reporting_time).slice(0, 5)} IST · ${plan.allowed_late_days} cutoff misses`
  ].filter(Boolean).join(" + ");
  const reward = plan.attendance_reward_type === "per_shipment"
    ? `₹${Number(plan.rate_value).toLocaleString("en-IN")} / delivered shipment`
    : `₹${Number(plan.flat_amount).toLocaleString("en-IN")} flat`;
  return `${plan.cycle_type === "monthly" ? "Monthly" : "15-day"} · ${requirements} · ${reward}`;
}

export default async function IncentivePlansPage({ searchParams }: { searchParams?: { saved?: string; error?: string } }) {
  const authorization = await requirePagePermission("payment_methods", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.payment_methods;
  if (!supabaseAdmin) return <AppShell active="Payment Methods" pageCode="payment_methods"><PageHead eyebrow="Master Data" title="Incentive plans" subtitle="Database connection is unavailable." /></AppShell>;
  const [providers, models, stations, designations, plans] = await Promise.all([
    supabaseAdmin.from("providers").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("location_models").select("id,code,name,provider_id").eq("company_id", companyId).eq("is_active", true).order("code"),
    supabaseAdmin.from("stations").select("id,station_code,station_name,provider_id,location_model_id").eq("company_id", companyId).order("station_code"),
    supabaseAdmin.from("designations").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("workforce_incentive_campaigns").select("id,code,name,provider_id,location_model_id,station_id,designation_id,incentive_type,cycle_type,metric,calculation_type,minimum_activity,reporting_time,minimum_present_days,allowed_late_days,attendance_required,reporting_time_required,attendance_threshold_type,maximum_absent_days,attendance_reward_type,rate_value,flat_amount,tiers,effective_from,effective_to,status,providers(name),location_models(code,name),stations(station_code),designations(code,name)").eq("company_id", companyId).order("effective_from", { ascending: false }).order("code")
  ]);
  const databaseError = providers.error?.message || models.error?.message || stations.error?.message || designations.error?.message || plans.error?.message;
  const error = databaseError || searchParams?.error;
  return <AppShell active="Payment Methods" pageCode="payment_methods">
    <PageHead eyebrow="Workforce master" title="Incentive plans" subtitle="Build one policy, choose its scope and qualification, then activate it. The same result appears in payouts and DropX One." action={<PendingLink className="button secondary" href="/master/payment-methods">Payment methods</PendingLink>} />
    {error ? <section className="message-panel error">{error}</section> : null}
    {searchParams?.saved ? <section className="message-panel success">Plan saved. Published payouts remain unchanged.</section> : null}
    {permission.canAdd && !databaseError ? <section className="panel">
      <div className="panel-head"><div><h2>New incentive plan</h2><p className="subtle">Only fields relevant to the selected incentive are shown.</p></div></div>
      <IncentivePlanForm providers={providers.data ?? []} models={models.data ?? []} stations={stations.data ?? []} designations={designations.data ?? []} />
    </section> : null}
    <section className="panel">
      <div className="panel-head"><div><h2>Configured plans</h2><p className="subtle">{(plans.data ?? []).length} plan{(plans.data ?? []).length === 1 ? "" : "s"}</p></div></div>
      <div className="table-wrap"><ReportTable>
        <thead><tr><th>Plan</th><th>Scope</th><th>Rule</th><th>Effective</th><th>Status</th>{permission.canEdit ? <th>Action</th> : null}</tr></thead>
        <tbody>{(plans.data ?? []).length ? (plans.data ?? []).map((plan: any) => <tr key={plan.id}>
          <td><strong>{plan.name}</strong><small>{plan.code}</small></td>
          <td>{plan.providers?.name ?? "All providers"}<small>{plan.location_models ? `${plan.location_models.code} · ${plan.location_models.name}` : "All models"} · {plan.stations?.station_code ?? "All locations"} · {plan.designations ? `${plan.designations.code} · ${plan.designations.name}` : "All designations"}</small></td>
          <td>{plan.incentive_type === "attendance" ? (plan.attendance_required === false ? "Reporting time" : plan.reporting_time_required === false ? "Attendance" : "Attendance + reporting time") : plan.incentive_type === "conversion" ? "Delivery conversion" : String(plan.metric).replaceAll("_", " ")}<small>{plan.incentive_type === "attendance" ? attendanceSummary(plan) : `${plan.cycle_type.replaceAll("_", " ")} · minimum ${Number(plan.minimum_activity).toLocaleString("en-IN")}${plan.incentive_type === "conversion" ? ` · ${(plan.tiers ?? []).map((tier: any) => `${tier.minimum}% → ₹${Number(tier.amount).toLocaleString("en-IN")}`).join(" · ")}` : ""}`}</small></td>
          <td>{plan.effective_from}<small>to {plan.effective_to}</small></td>
          <td><StatusPill status={plan.status} /></td>
          {permission.canEdit ? <td><form action={updateIncentivePlanStatus}><input type="hidden" name="id" value={plan.id} /><select aria-label={`Status for ${plan.name}`} name="status" defaultValue={plan.status}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option></select><SubmitButton className="button secondary compact">Update</SubmitButton></form></td> : null}
        </tr>) : <tr><td className="empty-cell" colSpan={permission.canEdit ? 6 : 5}>No plans configured. No incentive is paid until a plan is activated.</td></tr>}</tbody>
      </ReportTable></div>
    </section>
  </AppShell>;
}

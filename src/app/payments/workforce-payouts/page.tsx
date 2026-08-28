import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { WorkforcePayoutTable, type WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";
const metricValue = (row: any, source: string) => source === "amazon_delivery" ? Number(row.delivery_units ?? 0)
  : source === "swa_delivery" ? Number(row.swa_units ?? 0)
  : source === "total_delivery" ? Number(row.delivery_units ?? 0) + Number(row.swa_units ?? 0)
  : source === "customer_return" ? Number(row.customer_return_units ?? 0)
  : source === "seller_pickup" ? Number(row.mfn_units ?? 0)
  : source === "seller_return" ? Number(row.seller_return_units ?? 0)
  : Number(row.other_metrics?.[source] ?? 0);

async function loadRows(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) return { rows: [] as WorkforcePayoutRow[], error: "Database connection is not configured." };
  let locationsQuery = supabaseAdmin.from("stations").select("id, station_code, station_name, location_model_id").eq("company_id", companyId);
  if (!authorization.hasAllLocationAccess) locationsQuery = locationsQuery.in("id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE]);
  const [locationsResult, mappingsResult, allocationResult] = await Promise.all([
    locationsQuery,
    supabaseAdmin.from("field_executive_provider_mappings").select("id, provider_member_id, station_id, provider_id, contractor_id, employee_id, field_executive_id, payment_method_id, payment_values, effective_from, effective_to, status, providers(name), payment_methods(name)").eq("company_id", companyId).eq("status", "active").not("payment_method_id", "is", null),
    supabaseAdmin.from("payment_field_provider_metrics").select("payment_field_id, provider_id, provider_model_id, provider_production_metrics(source_key), payment_fields(code, field_type)").eq("company_id", companyId)
  ]);
  const error = locationsResult.error?.message || mappingsResult.error?.message || allocationResult.error?.message;
  if (error) return { rows: [] as WorkforcePayoutRow[], error };
  const locations = locationsResult.data ?? [];
  const allowed = new Set(locations.map((row) => row.id));
  const mappings = (mappingsResult.data ?? []).filter((row: any) => allowed.has(row.station_id));
  const sourceIds = Array.from(new Set(mappings.flatMap((row: any) => [row.contractor_id,row.employee_id,row.field_executive_id]).filter(Boolean)));
  const mappingIds = mappings.map((row: any) => row.id);
  const from = new Date(); from.setDate(1); const fromDate = from.toISOString().slice(0,10); const toDate = new Date().toISOString().slice(0,10);
  const [workforceResult, metricsResult, modelsResult] = await Promise.all([
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, dropx_id, full_name").eq("company_id", companyId).in("source_profile_id", sourceIds) : Promise.resolve({ data: [], error: null }),
    mappingIds.length ? supabaseAdmin.from("provider_daily_metrics").select("mapping_id, delivery_units, customer_return_units, mfn_units, seller_return_units, swa_units, other_metrics").in("mapping_id", mappingIds).gte("work_date", fromDate).lte("work_date", toDate) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("location_models").select("id, code, name").eq("company_id", companyId)
  ]);
  if (workforceResult.error || metricsResult.error || modelsResult.error) return { rows: [] as WorkforcePayoutRow[], error: workforceResult.error?.message || metricsResult.error?.message || modelsResult.error?.message || "Unable to load payout data." };
  const workerBySource = new Map((workforceResult.data ?? []).map((row: any) => [row.source_profile_id, row]));
  const locationById = new Map(locations.map((row: any) => [row.id, row])); const modelById = new Map((modelsResult.data ?? []).map((row: any) => [row.id, row]));
  const metricsByMapping = new Map<string, any[]>(); (metricsResult.data ?? []).forEach((row: any) => metricsByMapping.set(row.mapping_id, [...(metricsByMapping.get(row.mapping_id) ?? []), row]));
  const allocations = allocationResult.data ?? [];
  const rows = mappings.map((mapping: any) => {
    const sourceId = mapping.contractor_id || mapping.employee_id || mapping.field_executive_id; const worker = workerBySource.get(sourceId); const location: any = locationById.get(mapping.station_id); const model: any = modelById.get(location?.location_model_id);
    let baseAmount = 0; let production = 0;
    allocations.filter((item: any) => item.provider_id === mapping.provider_id && (!item.provider_model_id || item.provider_model_id === location?.location_model_id)).forEach((item: any) => {
      const field: any = Array.isArray(item.payment_fields) ? item.payment_fields[0] : item.payment_fields; const metric: any = Array.isArray(item.provider_production_metrics) ? item.provider_production_metrics[0] : item.provider_production_metrics;
      if (!field?.code || field.field_type !== "production" || !metric?.source_key) return;
      const count = (metricsByMapping.get(mapping.id) ?? []).reduce((sum, daily) => sum + metricValue(daily, metric.source_key), 0); const rate = Number(mapping.payment_values?.[field.code] ?? 0); production += count; baseAmount += count * rate;
    });
    return { id: mapping.id, dropxId: worker?.dropx_id ?? "-", name: worker?.full_name ?? "Unlinked workforce", providerMemberId: mapping.provider_member_id ?? "-", locationId: mapping.station_id, location: location ? `${location.station_code} - ${location.station_name}` : "-", provider: mapping.providers?.name ?? "-", model: model ? `${model.code} - ${model.name}` : "All models", paymentMethod: mapping.payment_methods?.name ?? "-", production, baseAmount, additions: 0, deductions: 0, netAmount: baseAmount, status: production > 0 ? "Ready for review" : "Awaiting production" } satisfies WorkforcePayoutRow;
  });
  return { rows, error: null };
}

export const dynamic = "force-dynamic";
export default async function WorkforcePayoutsPage() {
  const authorization = await requirePagePermission("workforce_payouts", "access"); const companyId = requireCompanyId(authorization); const { rows, error } = await loadRows(companyId, authorization);
  const gross = rows.reduce((sum, row) => sum + row.baseAmount, 0); const ready = rows.filter((row) => row.production > 0).length;
  return <AppShell active="Workforce Payouts" pageCode="workforce_payouts"><PageHead eyebrow="Payments" title="Workforce Payouts" subtitle="Calculate mapped workforce earnings from provider production, then review additions and deductions before payout." action={<PendingLink className="button secondary" href="/master/payment-methods?deductions=1">Deduction Heads</PendingLink>} />
    {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load payouts</strong><p className="subtle">{error}</p></div></section> : <><div className="stat-grid four"><div className="stat-card"><span>Mapped workers</span><strong>{rows.length}</strong></div><div className="stat-card"><span>Payment rows</span><strong>{ready}</strong></div><div className="stat-card"><span>Gross amount</span><strong>Rs {gross.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div><div className="stat-card"><span>Pending review</span><strong>{ready}</strong></div></div><section className="panel"><div className="panel-head"><div><h2>Current month payout worksheet</h2><p className="subtle">Only workforce in your allocated locations is shown. Production is calculated from normalized provider data.</p></div></div><WorkforcePayoutTable rows={rows} /></section></>}
  </AppShell>;
}

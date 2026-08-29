import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { WorkforcePayoutTable, type WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";
type ReportPeriod = { mode: "monthly" | "daily" | "range"; month: string; day: string; from: string; to: string };

function today() { return new Date().toISOString().slice(0, 10); }
function currentMonth() { return today().slice(0, 7); }
function validDate(value?: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : ""; }
function validMonth(value?: string) { return /^\d{4}-\d{2}$/.test(value ?? "") ? value! : ""; }

function resolvePeriod(params: Record<string, string | string[] | undefined>): ReportPeriod & { fromDate: string; toDate: string; title: string } {
  const mode = params.period === "daily" || params.period === "range" ? params.period : "monthly";
  const month = validMonth(typeof params.month === "string" ? params.month : "") || currentMonth();
  const day = validDate(typeof params.day === "string" ? params.day : "") || today();
  const from = validDate(typeof params.from === "string" ? params.from : "") || `${month}-01`;
  const to = validDate(typeof params.to === "string" ? params.to : "") || today();
  if (mode === "daily") return { mode, month, day, from, to, fromDate: day, toDate: day, title: `Daily payout worksheet · ${day}` };
  if (mode === "range") return { mode, month, day, from, to, fromDate: from <= to ? from : to, toDate: from <= to ? to : from, title: `Payout worksheet · ${from <= to ? from : to} to ${from <= to ? to : from}` };
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  return { mode, month, day, from, to, fromDate: `${month}-01`, toDate: end.toISOString().slice(0, 10), title: `Monthly payout worksheet · ${month}` };
}
const metricValue = (row: any, source: string) => source === "amazon_delivery" ? Number(row.amazon_delivery ?? 0)
  : source === "swa_delivery" ? Number(row.swa_delivery ?? 0)
  : source === "total_delivery" ? Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)))
  : source === "customer_return" ? Number(row.c_return ?? 0)
  : source === "seller_pickup" ? Number(row.mfn ?? 0)
  : source === "seller_return" ? Number(row.mfn_return ?? 0)
  : 0;

async function loadRows(companyId: string, authorization: AuthorizationContext, fromDate: string, toDate: string) {
  if (!supabaseAdmin) return { rows: [] as WorkforcePayoutRow[], error: "Database connection is not configured." };
  let locationsQuery = supabaseAdmin.from("stations").select("id, station_code, station_name, location_model_id").eq("company_id", companyId);
  if (!authorization.hasAllLocationAccess) locationsQuery = locationsQuery.in("id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE]);
  const [locationsResult, mappingsResult, allocationResult] = await Promise.all([
    locationsQuery,
    supabaseAdmin.from("field_executive_provider_mappings").select("id, provider_member_id, station_id, provider_id, contractor_id, employee_id, field_executive_id, payment_method_id, payment_values, effective_from, effective_to, status, providers(name), payment_methods(name)").eq("company_id", companyId).eq("status", "active").not("payment_method_id", "is", null),
    supabaseAdmin.from("payment_field_provider_metrics").select("payment_field_id, provider_id, provider_model_id, provider_production_metrics(source_key), payment_fields(code, label, field_type)").eq("company_id", companyId)
  ]);
  const error = locationsResult.error?.message || mappingsResult.error?.message || allocationResult.error?.message;
  if (error) return { rows: [] as WorkforcePayoutRow[], error };
  const locations = locationsResult.data ?? [];
  const allowed = new Set(locations.map((row) => row.id));
  const mappings = (mappingsResult.data ?? []).filter((row: any) => allowed.has(row.station_id));
  const sourceIds = Array.from(new Set(mappings.flatMap((row: any) => [row.contractor_id,row.employee_id,row.field_executive_id]).filter(Boolean)));
  const providerMemberIds = Array.from(new Set(mappings.map((row: any) => row.provider_member_id).filter(Boolean)));
  const [workforceResult, metricsResult, modelsResult] = await Promise.all([
    sourceIds.length ? supabaseAdmin.from("workforce").select("id, source_profile_id, dropx_id, full_name").eq("company_id", companyId).in("source_profile_id", sourceIds) : Promise.resolve({ data: [], error: null }),
    providerMemberIds.length ? supabaseAdmin.from("cps_shipment_daily").select("provider_employee_id, work_date, amazon_delivery, swa_delivery, total_delivery, c_return, mfn, mfn_return").eq("company_id", companyId).in("provider_employee_id", providerMemberIds).gte("work_date", fromDate).lte("work_date", toDate).limit(50000) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("location_models").select("id, code, name").eq("company_id", companyId)
  ]);
  if (workforceResult.error || metricsResult.error || modelsResult.error) return { rows: [] as WorkforcePayoutRow[], error: workforceResult.error?.message || metricsResult.error?.message || modelsResult.error?.message || "Unable to load payout data." };
  const workerBySource = new Map((workforceResult.data ?? []).map((row: any) => [row.source_profile_id, row]));
  const locationById = new Map(locations.map((row: any) => [row.id, row])); const modelById = new Map((modelsResult.data ?? []).map((row: any) => [row.id, row]));
  const metricsByProviderMember = new Map<string, any[]>(); (metricsResult.data ?? []).forEach((row: any) => metricsByProviderMember.set(row.provider_employee_id, [...(metricsByProviderMember.get(row.provider_employee_id) ?? []), row]));
  const allocations = allocationResult.data ?? [];
  const rows = mappings.map((mapping: any) => {
    const sourceId = mapping.contractor_id || mapping.employee_id || mapping.field_executive_id; const worker = workerBySource.get(sourceId); const location: any = locationById.get(mapping.station_id); const model: any = modelById.get(location?.location_model_id);
    let baseAmount = 0; let production = 0;
    const productionBreakdown: WorkforcePayoutRow["productionBreakdown"] = [];
    allocations.filter((item: any) => item.provider_id === mapping.provider_id && (!item.provider_model_id || item.provider_model_id === location?.location_model_id)).forEach((item: any) => {
      const field: any = Array.isArray(item.payment_fields) ? item.payment_fields[0] : item.payment_fields; const metric: any = Array.isArray(item.provider_production_metrics) ? item.provider_production_metrics[0] : item.provider_production_metrics;
      if (!field?.code || field.field_type !== "production" || !metric?.source_key) return;
      const count = (metricsByProviderMember.get(mapping.provider_member_id) ?? []).filter((daily) => daily.work_date >= mapping.effective_from && (!mapping.effective_to || daily.work_date <= mapping.effective_to)).reduce((sum, daily) => sum + metricValue(daily, metric.source_key), 0);
      const rate = Number(mapping.payment_values?.[field.code] ?? 0); const amount = count * rate;
      production += count; baseAmount += amount;
      productionBreakdown.push({ code: field.code, label: field.label || field.code, count, rate, amount });
    });
    return { id: mapping.id, dropxId: worker?.dropx_id ?? "-", name: worker?.full_name ?? "Unlinked workforce", providerMemberId: mapping.provider_member_id ?? "-", locationId: mapping.station_id, location: location?.station_code ?? "-", provider: mapping.providers?.name ?? "-", model: model ? `${model.code} - ${model.name}` : "All models", paymentMethod: mapping.payment_methods?.name ?? "-", production, productionBreakdown, baseAmount, additions: 0, deductions: 0, netAmount: baseAmount, status: production > 0 ? "Ready for review" : "Awaiting production" } satisfies WorkforcePayoutRow;
  });
  return { rows, error: null };
}

export const dynamic = "force-dynamic";
export default async function WorkforcePayoutsPage({ searchParams = {} }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const period = resolvePeriod(searchParams);
  const authorization = await requirePagePermission("workforce_payouts", "access"); const companyId = requireCompanyId(authorization); const { rows, error } = await loadRows(companyId, authorization, period.fromDate, period.toDate);
  const gross = rows.reduce((sum, row) => sum + row.baseAmount, 0); const ready = rows.filter((row) => row.production > 0).length;
  return <AppShell active="Workforce Payouts" pageCode="workforce_payouts"><PageHead eyebrow="Payments" title="Workforce Payouts" subtitle="Calculate mapped workforce earnings from provider production, then review additions and deductions before payout." action={<PendingLink className="button secondary" href="/master/payment-methods?deductions=1">Deduction Heads</PendingLink>} />
    {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load payouts</strong><p className="subtle">{error}</p></div></section> : <><div className="stat-grid four"><div className="stat-card"><span>Mapped workers</span><strong>{rows.length}</strong></div><div className="stat-card"><span>Payment rows</span><strong>{ready}</strong></div><div className="stat-card"><span>Gross amount</span><strong>Rs {gross.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div><div className="stat-card"><span>Pending review</span><strong>{ready}</strong></div></div><section className="panel"><div className="panel-head payout-period-head"><div><h2>{period.title}</h2><p className="subtle">Only workforce in your allocated locations is shown. Production is calculated from normalized provider data.</p></div><form className="payout-period-filter" method="get"><label>Period<select className="field" name="period" defaultValue={period.mode}><option value="monthly">Monthly</option><option value="daily">Daily</option><option value="range">Custom range</option></select></label><label>Month<input className="field" type="month" name="month" defaultValue={period.month} /></label><label>Day<input className="field" type="date" name="day" defaultValue={period.day} /></label><label>From<input className="field" type="date" name="from" defaultValue={period.from} /></label><label>To<input className="field" type="date" name="to" defaultValue={period.to} /></label><button className="button secondary" type="submit">Apply</button></form></div><WorkforcePayoutTable rows={rows} /></section></>}
  </AppShell>;
}

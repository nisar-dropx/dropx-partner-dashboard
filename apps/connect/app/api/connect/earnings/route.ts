import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] : value ?? null; }
function metricValue(row: Record<string, unknown>, source: string) {
  const number = (key: string) => Number(row[key] ?? 0);
  if (source === "amazon_delivery") return number("amazon_delivery");
  if (source === "swa_delivery") return number("swa_delivery");
  if (source === "total_delivery") return number("total_delivery") || number("amazon_delivery") + number("swa_delivery");
  if (source === "customer_return") return number("c_return");
  if (source === "seller_pickup") return number("mfn");
  if (source === "seller_return") return number("mfn_return");
  return 0;
}
function validMonth(value: string | null) { return /^\d{4}-\d{2}$/.test(value ?? "") ? value! : new Date().toISOString().slice(0, 7); }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const accountId = String(url.searchParams.get("accountId") ?? "").trim(); const profileType = String(url.searchParams.get("profileType") ?? "").trim() as ConnectAccount["profileType"];
    if (!accountId || !profileType) throw new Error("Select your workforce account.");
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce" || !account.pageAccess.includes("earnings")) throw new Error("My Earnings is not enabled for this account.");
    const month = validMonth(url.searchParams.get("month")); const from = `${month}-01`; const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); const to = end.toISOString().slice(0, 10);
    const identityFilter = account.profileType === "contractor" ? `contractor_id.eq.${account.id}` : account.profileType === "employee" ? `employee_id.eq.${account.id}` : `workforce_id.eq.${account.id},field_executive_id.eq.${account.id}`;
    const mappingResult = await db().from("field_executive_provider_mappings").select("id,provider_member_id,station_id,provider_id,workforce_id,contractor_id,employee_id,field_executive_id,payment_method_id,payment_values,effective_from,effective_to,providers(name),payment_methods(name)").eq("company_id", account.companyId).eq("status", "active").not("payment_method_id", "is", null).or(identityFilter);
    if (mappingResult.error) throw new Error(mappingResult.error.message);
    const mappings = mappingResult.data ?? []; const stationIds = [...new Set(mappings.map((row) => row.station_id).filter(Boolean))]; const memberIds = [...new Set(mappings.map((row) => row.provider_member_id).filter(Boolean))];
    const [stationsResult, metricsResult, allocationsResult] = await Promise.all([
      stationIds.length ? db().from("stations").select("id,station_code,location_model_id").eq("company_id", account.companyId).in("id", stationIds) : Promise.resolve({ data: [], error: null }),
      memberIds.length ? db().from("cps_shipment_daily").select("provider_employee_id,work_date,amazon_delivery,swa_delivery,total_delivery,c_return,mfn,mfn_return").eq("company_id", account.companyId).in("provider_employee_id", memberIds).gte("work_date", from).lte("work_date", to) : Promise.resolve({ data: [], error: null }),
      db().from("payment_field_provider_metrics").select("provider_id,provider_model_id,provider_production_metrics(source_key),payment_fields(code,label,field_type)").eq("company_id", account.companyId)
    ]);
    const error = stationsResult.error?.message || metricsResult.error?.message || allocationsResult.error?.message; if (error) throw new Error(error);
    const stationById = new Map((stationsResult.data ?? []).map((row) => [row.id, row])); const dailyByMember = new Map<string, Array<Record<string, unknown>>>();
    (metricsResult.data ?? []).forEach((row) => dailyByMember.set(String(row.provider_employee_id), [...(dailyByMember.get(String(row.provider_employee_id)) ?? []), row as Record<string, unknown>]));
    const earnings = mappings.map((mapping: any) => {
      const station: any = stationById.get(mapping.station_id); const daily = (dailyByMember.get(String(mapping.provider_member_id)) ?? []).filter((row) => String(row.work_date) >= String(mapping.effective_from ?? from) && (!mapping.effective_to || String(row.work_date) <= String(mapping.effective_to)));
      const production = (allocationsResult.data ?? []).filter((allocation: any) => allocation.provider_id === mapping.provider_id && (!allocation.provider_model_id || allocation.provider_model_id === station?.location_model_id)).flatMap((allocation: any) => {
        const field: any = first(allocation.payment_fields); const metric: any = first(allocation.provider_production_metrics); if (!field?.code || field.field_type !== "production" || !metric?.source_key) return [];
        const count = daily.reduce((sum, row) => sum + metricValue(row, metric.source_key), 0); const rate = Number(mapping.payment_values?.[field.code] ?? 0); return [{ label: field.label || field.code, count, rate, amount: count * rate }];
      });
      const baseAmount = production.reduce((sum: number, line: any) => sum + line.amount, 0); const additions = 0;
      return { id: mapping.id, location: station?.station_code ?? "-", provider: first(mapping.providers)?.name ?? "-", model: station?.location_model_id ? "Mapped model" : "All models", paymentMethod: first(mapping.payment_methods)?.name ?? "-", workDays: new Set(daily.map((row) => String(row.work_date))).size, production, baseAmount, additions, grossAmount: baseAmount + additions };
    });
    const summary = earnings.reduce((total, row) => ({ workDays: total.workDays + row.workDays, baseAmount: total.baseAmount + row.baseAmount, additions: total.additions + row.additions, grossAmount: total.grossAmount + row.grossAmount }), { workDays: 0, baseAmount: 0, additions: 0, grossAmount: 0 });
    return NextResponse.json({ month, earnings, summary }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load earnings." }, { status: 400 }); }
}

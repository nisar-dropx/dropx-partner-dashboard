import {paymentMappingForDay} from "@/lib/workforce-payment-mapping";
import {workforcePaymentMonth} from "@/lib/workforce-payment-period";
import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import {loadOwnAdjustmentLedger} from '@/lib/workforce-own-adjustments';
import {allocateOwnDailyCards,type DailyCardSource} from '@/lib/workforce-daily-card';
import {ownIncentives,type IncentiveSource,type OwnCampaign} from '@/lib/workforce-own-incentives';

export const dynamic='force-dynamic';

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
function validMonth(value: string | null) { if(value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("Choose a valid month."); return value || workforcePaymentMonth().from.slice(0,7); }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const accountId = String(url.searchParams.get("accountId") ?? "").trim(); const profileType = String(url.searchParams.get("profileType") ?? "").trim() as ConnectAccount["profileType"];
    if (!accountId || !profileType) throw new Error("Select your workforce account.");
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce" || !account.pageAccess.includes("earnings")) throw new Error("My Earnings is not enabled for this account.");
    const month = validMonth(url.searchParams.get("month")); const from = `${month}-01`; const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); const to = end.toISOString().slice(0, 10);
    const columns:Record<string,string>={contractor:"contractor_id",employee:"employee_id",field_executive:"field_executive_id"};
    const filters=account.profileType==="workforce" ? [`workforce_id.eq.${account.id}`] : columns[account.profileType] ? [`and(workforce_id.is.null,${columns[account.profileType]}.eq.${account.id})`] : [];
    if(account.profileType==="workforce"){
      const source=await db().from("workforce").select("source_profile_id,source_profile_type").eq("company_id",account.companyId).eq("id",account.id).maybeSingle();
      if(source.error) throw new Error("Your Workforce identity could not be verified.");
      if(source.data?.source_profile_id && columns[source.data.source_profile_type])filters.push(`and(workforce_id.is.null,${columns[source.data.source_profile_type]}.eq.${source.data.source_profile_id})`);
    }
    const identityFilter=filters.length ? filters.join(","):"id.eq.00000000-0000-0000-0000-000000000000";
    const mappingResult = await db().from("field_executive_provider_mappings").select("id,provider_member_id,station_id,provider_id,workforce_id,contractor_id,employee_id,field_executive_id,payment_method_id,payment_values,effective_from,effective_to,providers(name,code),stations(station_code),payment_methods(name)").eq("company_id", account.companyId).neq("status", "cancelled").lte("effective_from",to).or(`effective_to.is.null,effective_to.gte.${from}`).or(identityFilter);
    if (mappingResult.error) throw new Error(mappingResult.error.message);
    const mappings = mappingResult.data ?? []; const stationIds = [...new Set(mappings.map((row) => row.station_id).filter(Boolean))]; const memberIds = [...new Set(mappings.map((row) => row.provider_member_id).filter(Boolean))];
    let canonicalQuery=db().from('workforce').select('id,designation_id,location_id').eq('company_id',account.companyId).is('deleted_at',null).neq('migration_state','reclassified');
    canonicalQuery=account.profileType==='workforce'?canonicalQuery.eq('id',account.id):canonicalQuery.eq('source_profile_type',account.profileType).eq('source_profile_id',account.id);
    const [stationsResult, metricsResult, allocationsResult, workforceResult, rateCardsResult, adjustments, campaignResult] = await Promise.all([
      stationIds.length ? db().from("stations").select("id,station_code,location_model_id").eq("company_id", account.companyId).in("id", stationIds) : Promise.resolve({ data: [], error: null }),
      memberIds.length ? db().from("cps_shipment_daily").select("id,provider_employee_id,work_date,station_code,client,total_activity,amazon_delivery,swa_delivery,total_delivery,c_return,mfn,mfn_return").eq("company_id", account.companyId).in("provider_employee_id", memberIds).gte("work_date", from).lte("work_date", to) : Promise.resolve({ data: [], error: null }),
      db().from("payment_field_provider_metrics").select("provider_id,provider_model_id,provider_production_metrics(source_key),payment_fields(code,label,field_type)").eq("company_id", account.companyId),
      canonicalQuery.maybeSingle(),
      db().from("workforce_rate_cards").select("id,provider_id,station_id,designation_id,pay_type,effective_from,effective_to,delivery_rate,return_rate,mfn_rate,mfn_return_rate,fuel_rate,fixed_amount,guarantee_amount,status,approved_at").eq("company_id", account.companyId).neq("status", "draft").lte("effective_from", to).or(`effective_to.is.null,effective_to.gte.${from}`),
      loadOwnAdjustmentLedger(db(),account,from,to),
      db().from('workforce_incentive_campaigns').select('id,company_id,name,provider_id,station_id,designation_id,metric,calculation_type,threshold_value,rate_value,flat_amount,maximum_amount,effective_from,effective_to,status,approved_at').eq('company_id',account.companyId).neq('status','draft').lte('effective_from',to).gte('effective_to',from)
    ]);
    const error = stationsResult.error?.message || metricsResult.error?.message || allocationsResult.error?.message || workforceResult.error?.message || rateCardsResult.error?.message; if (error) throw new Error(error);
    if(campaignResult.error)throw new Error('Your incentive estimate could not be verified. Refresh before relying on earnings.');
    const stationById = new Map((stationsResult.data ?? []).map((row) => [row.id, row])); const dailyByMember = new Map<string, Array<Record<string, unknown>>>();
    (metricsResult.data ?? []).forEach((row) => dailyByMember.set(String(row.provider_employee_id), [...(dailyByMember.get(String(row.provider_employee_id)) ?? []), row as Record<string, unknown>]));
    const workforce = workforceResult.data as { id:string;designation_id?: string | null; location_id?: string | null } | null;
    if(mappings.length>=1000 || (metricsResult.data ?? []).length>=1000 || (allocationsResult.data ?? []).length>=1000 || (rateCardsResult.data ?? []).length>=1000 || (campaignResult.data??[]).length>=1000) throw new Error("Too many earning records to reconcile safely. Please contact Workforce.");
    const incentives=ownIncentives({companyId:account.companyId,canonical:Boolean(workforce?.id),designationId:workforce?.designation_id??null,from,to,campaigns:(campaignResult.data??[]) as OwnCampaign[],sources:(metricsResult.data??[]).flatMap(row=>{
      const mapping=paymentMappingForDay(mappings,row);
      return mapping?[{...row,provider_id:mapping.provider_id,station_id:mapping.station_id} as IncentiveSource]:[];
    })});
    const cards = (rateCardsResult.data ?? []).filter(card=>card.status==="active" || (["paused","closed"].includes(card.status) && card.approved_at && card.effective_to));
    const cardFor = (mapping: any, workDate: string) => cards
      .filter((card: any) => card.provider_id === mapping.provider_id && (!card.station_id || card.station_id === mapping.station_id) && (!card.designation_id || card.designation_id === workforce?.designation_id) && String(card.effective_from) <= workDate && (!card.effective_to || String(card.effective_to) >= workDate))
      .sort((left: any, right: any) => ((right.station_id ? 2 : 0) + (right.designation_id ? 1 : 0)) - ((left.station_id ? 2 : 0) + (left.designation_id ? 1 : 0)) || String(right.effective_from).localeCompare(String(left.effective_from)))[0] ?? null;
    const dailyCardAmounts=allocateOwnDailyCards((metricsResult.data??[]).flatMap(row=>{
      const mapping=paymentMappingForDay(mappings,row),card=mapping?cardFor(mapping,String(row.work_date)):null;
      return card?[{row:row as DailyCardSource,card}]:[];
    }));
    const earnings = mappings.map((mapping: any) => {
      const station: any = stationById.get(mapping.station_id); const daily = (dailyByMember.get(String(mapping.provider_member_id)) ?? []).filter((row) => paymentMappingForDay(mappings,row as {work_date:string;provider_employee_id:string;station_code:string;client:string})?.id === mapping.id);
      const productionRules = (allocationsResult.data ?? []).filter((allocation: any) => allocation.provider_id === mapping.provider_id && (!allocation.provider_model_id || allocation.provider_model_id === station?.location_model_id)).flatMap((allocation: any) => {
        const field: any = first(allocation.payment_fields); const metric: any = first(allocation.provider_production_metrics); if (!field?.code || field.field_type !== "production" || !metric?.source_key) return [];
        const rate = Number(mapping.payment_values?.[field.code] ?? 0); return [{ label: field.label || field.code, source: metric.source_key, rate }];
      });
      const production = productionRules.map((rule: any) => { const count = daily.reduce((sum, row) => sum + metricValue(row, rule.source), 0); return { label: rule.label, count, rate: rule.rate, amount: count * rule.rate }; });
      const dailyEarnings = daily.map((row) => { const production = productionRules.map((rule: any) => { const count = metricValue(row, rule.source); return { label: rule.label, count, rate: rule.rate, amount: count * rule.rate }; }); const card = cardFor(mapping, String(row.work_date)); const baseAmount=card?dailyCardAmounts.get(String(row.id))!:production.reduce((sum:number,line:any)=>sum+line.amount,0),incentiveAmount=incentives.bySource.get(String(row.id))??0; return { id:String(row.id),date: String(row.work_date), production, baseAmount,incentiveAmount,amount:Math.round((baseAmount+incentiveAmount)*100)/100 }; });
      const baseAmount = Math.round(dailyEarnings.reduce((sum: number, line) => sum + line.baseAmount, 0)*100)/100; const additions = Math.round(dailyEarnings.reduce((sum,line)=>sum+line.incentiveAmount,0)*100)/100;
      return { id: mapping.id, location: station?.station_code ?? "-", provider: first(mapping.providers)?.name ?? "-", model: station?.location_model_id ? "Mapped model" : "All models", paymentMethod: first(mapping.payment_methods)?.name ?? "-", workDays: new Set(daily.map((row) => String(row.work_date))).size, production, daily: dailyEarnings, baseAmount, additions, grossAmount: baseAmount + additions };
    });
    const summary = earnings.reduce((total, row) => ({ workDays: total.workDays + row.workDays, baseAmount: total.baseAmount + row.baseAmount, additions: total.additions + row.additions, grossAmount: total.grossAmount + row.grossAmount }), { workDays: 0, baseAmount: 0, additions: 0, grossAmount: 0 });
    summary.workDays=new Set(earnings.flatMap(row=>row.daily.map(day=>day.date))).size;
    summary.baseAmount=Math.round(summary.baseAmount*100)/100;
    // Posted adjustments remain part of this period's estimate exactly once. Statements are
    // a separate historical record, never added again and never treated as outstanding dues.
    summary.additions=adjustments.summary.additions;
    summary.grossAmount=Math.round((summary.baseAmount+incentives.summary.amount+summary.additions)*100)/100;
    const deductionAmount=adjustments.summary.deductions,netAmount=Math.round((summary.grossAmount-deductionAmount)*100)/100;
    return NextResponse.json({ month, earnings, adjustments, incentives:incentives.summary,summary:{...summary,incentiveAmount:incentives.summary.amount,deductionAmount,netAmount} }, { headers: { "Cache-Control": "private, no-store", "Vary":"Cookie" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load earnings." }, { status: 400,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"} }); }
}

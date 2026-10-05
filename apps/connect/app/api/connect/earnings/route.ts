import {paymentMappingForDay} from "@/lib/workforce-payment-mapping";
import {personalPaymentCard} from '@/lib/personal-payment-card';
import {workforcePaymentMonth} from "@/lib/workforce-payment-period";
import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import {loadOwnAdjustmentLedger} from '@/lib/workforce-own-adjustments';
import {allocateOwnDailyCards,type DailyCardSource} from '@/lib/workforce-daily-card';
import {ownIncentives,type IncentiveSource,type OwnCampaign} from '@/lib/workforce-own-incentives';
import {assertNoProviderDirectOverlap} from '@/lib/direct-workforce-payment';
import {attendanceIdentityFilter,loadDirectPaymentContext,paymentMethodById,resolveCanonicalPaymentWorker} from '@/lib/direct-workforce-payment-data';
import {calculateProviderAttendancePayments,hasProviderAttendanceComponents,type ProviderAttendanceMapping,type ProviderAttendanceRecord} from '@/lib/provider-attendance-payment';
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  shipmentAttendanceRecord,
  workforceAttendanceCaptureSettingForDate
} from '../../../../../../src/lib/workforce-attendance-capture.ts';
import {allocateCombinedProductionThresholds} from '../../../../../../src/lib/workforce-production-threshold.ts';

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
function mappingMethod(mapping: any) { return first(mapping?.payment_methods); }
function componentField(component: any) { return first(component?.payment_fields); }
function productionComponents(mapping: any) {
  const method: any = mappingMethod(mapping);
  return (method?.payment_method_components ?? []).filter((component: any) => {
    const field: any = componentField(component);
    return component.is_active !== false && (component.component_type === "production" || field?.field_type === "production" || field?.calculation_type === "count_x_rate");
  });
}
function productionRulesFor(mapping: any, station: any, allocations: any[]) {
  return productionComponents(mapping).flatMap((component: any, index: number) => {
    const field: any = componentField(component);
    const code = String(component.component_code || field?.code || "").trim();
    if (!code) return [];
    const matching = allocations.filter((allocation: any) => {
      const allocatedField: any = first(allocation.payment_fields);
      return allocation.provider_id === mapping.provider_id
        && (!allocation.provider_model_id || allocation.provider_model_id === station?.location_model_id)
        && String(allocatedField?.code ?? "").trim().toUpperCase() === code.toUpperCase();
    }).sort((left: any, right: any) => Number(Boolean(right.provider_model_id)) - Number(Boolean(left.provider_model_id)));
    const metric: any = first(matching[0]?.provider_production_metrics);
    const source = String(metric?.source_key ?? field?.calculation_source ?? "").trim();
    if (!source) return [];
    const rate = Number(mapping.payment_values?.[code] ?? Object.entries(mapping.payment_values ?? {}).find(([key]) => key.trim().toUpperCase() === code.toUpperCase())?.[1] ?? 0);
    if (!Number.isFinite(rate) || rate < 0) throw new Error("Your provider production rate is invalid. Contact Workforce.");
    return [{ code, label: String(component.label || field?.label || code), source, rate, order: Number(component.sort_order ?? index) }];
  });
}
function validMonth(value: string | null) {
  const current = workforcePaymentMonth().from.slice(0, 7);
  if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("Choose a valid month.");
  if (value && value > current) throw new Error("Choose the current month or an earlier month.");
  return value || current;
}
function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const accountId = String(url.searchParams.get("accountId") ?? "").trim(); const profileType = String(url.searchParams.get("profileType") ?? "").trim() as ConnectAccount["profileType"];
    if (!accountId || !profileType) throw new Error("Select your workforce account.");
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce" || !account.pageAccess.includes("earnings")) throw new Error("My Earnings is not enabled for this account.");
    const month = validMonth(url.searchParams.get("month")); const from = `${month}-01`; const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); const monthEnd = end.toISOString().slice(0, 10); const to = month === workforcePaymentMonth().from.slice(0, 7) ? [todayKolkata(), monthEnd].sort()[0] : monthEnd;
    const workforce = await resolveCanonicalPaymentWorker(account);
    const columns:Record<string,string>={contractor:"contractor_id",employee:"employee_id",field_executive:"field_executive_id"};
    const filters=account.profileType==="workforce" ? [`workforce_id.eq.${account.id}`] : columns[account.profileType] ? [`and(workforce_id.is.null,${columns[account.profileType]}.eq.${account.id})`] : [];
    if(account.profileType==="workforce"&&workforce?.source_profile_id&&workforce.source_profile_type&&columns[workforce.source_profile_type])filters.push(`and(workforce_id.is.null,${columns[workforce.source_profile_type]}.eq.${workforce.source_profile_id})`);
    const identityFilter=filters.length ? filters.join(","):"id.eq.00000000-0000-0000-0000-000000000000";
    const mappingResult = await db().from("field_executive_provider_mappings").select("id,provider_member_id,station_id,provider_id,workforce_id,contractor_id,employee_id,field_executive_id,payment_method_id,payment_values,production_threshold_config,pay_type,effective_from,effective_to,status,providers(name,code),stations(station_code),payment_methods(id,name,production_threshold_config,payment_method_components(component_code,component_type,label,pay_schedule,sort_order,is_active,payment_fields(code,label,field_type,pay_schedule,calculation_type,calculation_source)))").eq("company_id", account.companyId).neq("status", "cancelled").lte("effective_from",to).or(`effective_to.is.null,effective_to.gte.${from}`).or(identityFilter);
    if (mappingResult.error) throw new Error(mappingResult.error.message);
    const mappings = mappingResult.data ?? []; const stationIds = [...new Set(mappings.map((row) => row.station_id).filter(Boolean))]; const memberIds = [...new Set(mappings.map((row) => row.provider_member_id).filter(Boolean))];
    const direct = await loadDirectPaymentContext({companyId:account.companyId,workforceId:workforce?.id??null,from,to,employmentFrom:workforce?.date_of_join,employmentTo:workforce?.last_working_date,sourceProfileId:workforce?.source_profile_id,sourceProfileType:workforce?.source_profile_type});
    assertNoProviderDirectOverlap({allocations:direct.allocations,mappings,from,to});
    const [stationsResult, metricsResult, allocationsResult, rateCardsResult, adjustments, campaignResult, attendanceResult] = await Promise.all([
      stationIds.length ? db().from("stations").select("id,station_code,location_model_id").eq("company_id", account.companyId).in("id", stationIds) : Promise.resolve({ data: [], error: null }),
      memberIds.length ? db().from("cps_shipment_daily").select("id,provider_employee_id,work_date,station_code,client,total_activity,amazon_delivery,swa_delivery,total_delivery,c_return,mfn,mfn_return").eq("company_id", account.companyId).in("provider_employee_id", memberIds).gte("work_date", from).lte("work_date", to) : Promise.resolve({ data: [], error: null }),
      db().from("payment_field_provider_metrics").select("provider_id,provider_model_id,provider_production_metrics(source_key),payment_fields(code,label,field_type)").eq("company_id", account.companyId),
      db().from("workforce_rate_cards").select("id,provider_id,station_id,designation_id,pay_type,effective_from,effective_to,delivery_rate,return_rate,mfn_rate,mfn_return_rate,fuel_rate,fixed_amount,guarantee_amount,status,approved_at").eq("company_id", account.companyId).neq("status", "draft").lte("effective_from", to).or(`effective_to.is.null,effective_to.gte.${from}`),
      loadOwnAdjustmentLedger(db(),account,from,to),
      db().from('workforce_incentive_campaigns').select('id,company_id,name,provider_id,station_id,designation_id,metric,calculation_type,threshold_value,rate_value,flat_amount,maximum_amount,effective_from,effective_to,status,approved_at').eq('company_id',account.companyId).neq('status','draft').lte('effective_from',to).gte('effective_to',from),
      workforce?.id && mappings.length ? db().from('attendance_daily').select('id,punch_date,status,in_time,out_time,work_minutes').eq('company_id',account.companyId).or(attendanceIdentityFilter(workforce)).gte('punch_date',from).lte('punch_date',to).order('punch_date') : Promise.resolve({data:[],error:null})
    ]);
    const error = stationsResult.error?.message || metricsResult.error?.message || allocationsResult.error?.message || rateCardsResult.error?.message || attendanceResult.error?.message; if (error) throw new Error(error);
    if(campaignResult.error)throw new Error('Your incentive estimate could not be verified. Refresh before relying on earnings.');
    if((attendanceResult.data??[]).length>=1000)throw new Error('Too many attendance records to reconcile safely. Contact Workforce.');
    const stationById = new Map((stationsResult.data ?? []).map((row) => [row.id, row])); const dailyByMember = new Map<string, Array<Record<string, unknown>>>();
    (metricsResult.data ?? []).forEach((row) => dailyByMember.set(String(row.provider_employee_id), [...(dailyByMember.get(String(row.provider_employee_id)) ?? []), row as Record<string, unknown>]));
    if(mappings.length>=1000 || (metricsResult.data ?? []).length>=1000 || (allocationsResult.data ?? []).length>=1000 || (rateCardsResult.data ?? []).length>=1000 || (campaignResult.data??[]).length>=1000) throw new Error("Too many earning records to reconcile safely. Please contact Workforce.");
    const incentives=ownIncentives({companyId:account.companyId,canonical:Boolean(workforce?.id),designationId:workforce?.designation_id??null,from,to,campaigns:(campaignResult.data??[]) as OwnCampaign[],sources:(metricsResult.data??[]).flatMap(row=>{
      const mapping=paymentMappingForDay(mappings,row);
      return mapping?[{...row,provider_id:mapping.provider_id,station_id:mapping.station_id} as IncentiveSource]:[];
    })});
    const cards = (rateCardsResult.data ?? []).filter(card=>card.status==="active" || (["paused","closed"].includes(card.status) && card.approved_at && card.effective_to));
    const cardFor = (mapping: any, workDate: string) => personalPaymentCard(mapping) ?? cards
      .filter((card: any) => card.provider_id === mapping.provider_id && (!card.station_id || card.station_id === mapping.station_id) && (!card.designation_id || card.designation_id === workforce?.designation_id) && String(card.effective_from) <= workDate && (!card.effective_to || String(card.effective_to) >= workDate))
      .sort((left: any, right: any) => ((right.station_id ? 2 : 0) + (right.designation_id ? 1 : 0)) - ((left.station_id ? 2 : 0) + (left.designation_id ? 1 : 0)) || String(right.effective_from).localeCompare(String(left.effective_from)))[0] ?? null;
    const dailyCardAmounts=allocateOwnDailyCards((metricsResult.data??[]).flatMap(row=>{
      const mapping=paymentMappingForDay(mappings,row),card=mapping?cardFor(mapping,String(row.work_date)):null;
      return card?[{row:row as DailyCardSource,card}]:[];
    }));
    const productionMetaById=new Map<string,{mappingId:string;sourceId:string;label:string}>();
    const productionInputs=(metricsResult.data??[]).flatMap((row:any)=>{
      const mapping:any=paymentMappingForDay(mappings,row);
      if(!mapping)return [];
      const station:any=stationById.get(mapping.station_id);
      const method:any=mappingMethod(mapping);
      return productionRulesFor(mapping,station,allocationsResult.data??[]).map((rule:any,index:number)=>{
        const id=`${mapping.id}:${row.id}:${rule.code}:${index}`;
        productionMetaById.set(id,{mappingId:String(mapping.id),sourceId:String(row.id),label:rule.label});
        return {
          id,
          workforceId:String(workforce?.id??account.id),
          mappingId:String(mapping.id),
          date:String(row.work_date),
          effectiveFrom:String(mapping.effective_from??from),
          effectiveTo:mapping.effective_to?String(mapping.effective_to):null,
          componentCode:rule.code,
          componentOrder:rule.order,
          reportedUnits:metricValue(row as Record<string,unknown>,rule.source),
          rate:rule.rate,
          thresholdConfig:mapping.production_threshold_config,
          methodThresholdConfig:method?.production_threshold_config
        };
      });
    });
    const allocatedProductionBySource=new Map<string,Array<{label:string;count:number;reportedCount:number;rate:number;amount:number;thresholdApplied:boolean;thresholdDeducted:number;thresholdPeriod:"day"|"month"|null;thresholdMinimum:number|null;thresholdConfigurationMissing:boolean}>>();
    for(const allocated of allocateCombinedProductionThresholds(productionInputs)){
      const meta=productionMetaById.get(allocated.id);
      if(!meta)throw new Error("Your provider production could not be reconciled. Contact Workforce.");
      const key=`${meta.mappingId}:${meta.sourceId}`;
      const line={label:meta.label,count:allocated.payableUnits,reportedCount:allocated.reportedUnits,rate:allocated.rate,amount:allocated.amount,thresholdApplied:allocated.thresholdApplied,thresholdDeducted:allocated.thresholdDeducted,thresholdPeriod:allocated.thresholdPeriod,thresholdMinimum:allocated.thresholdMinimum,thresholdConfigurationMissing:allocated.thresholdConfigurationMissing};
      allocatedProductionBySource.set(key,[...(allocatedProductionBySource.get(key)??[]),line]);
    }
    const shipmentAttendanceByDay=aggregateShipmentDeliveriesByWorkforceDay((metricsResult.data??[]).flatMap(row=>{
      const date=String(row.work_date??'');
      return workforce?.id && paymentMappingForDay(mappings,row)
        ? [{workforce_id:workforce.id,work_date:date,total_delivery:Number(row.total_delivery??0)}]
        : [];
    }));
    const providerAttendance:ProviderAttendanceRecord[]=[...(attendanceResult.data??[]).filter(row=>
      workforceAttendanceCaptureSettingForDate(direct.attendanceCaptureHistory,String(row.punch_date)).capture_method==='biometric'
    )];
    if(workforce?.id) for(const [workerDate,totalDeliveries] of shipmentAttendanceByDay) {
      const date=workerDate.slice(workforce.id.length+1);
      const capture=workforceAttendanceCaptureSettingForDate(direct.attendanceCaptureHistory,date);
      if(capture.capture_method==='shipment_data') providerAttendance.push({id:`shipment:${workforce.id}:${date}`,...shipmentAttendanceRecord(date,totalDeliveries,capture)});
    }
    const providerAttendanceDays=calculateProviderAttendancePayments({mappings:mappings as unknown as ProviderAttendanceMapping[],attendance:providerAttendance,policyHistory:direct.policyHistory,attendanceCaptureHistory:direct.attendanceCaptureHistory,from,to});
    const providerAttendanceByMapping=new Map<string,typeof providerAttendanceDays>();
    for(const day of providerAttendanceDays)providerAttendanceByMapping.set(day.mappingId,[...(providerAttendanceByMapping.get(day.mappingId)??[]),day]);
    const providerEarnings = mappings.map((mapping: any) => {
      const station: any = stationById.get(mapping.station_id); const daily = (dailyByMember.get(String(mapping.provider_member_id)) ?? []).filter((row) => paymentMappingForDay(mappings,row as {work_date:string;provider_employee_id:string;station_code:string;client:string})?.id === mapping.id);
      const productionConfigured=productionComponents(mapping).length>0;
      const attendanceDays=providerAttendanceByMapping.get(String(mapping.id))??[];
      const remainingAttendance=new Map(attendanceDays.map(day=>[day.date,day]));
      const attendanceConfigured=hasProviderAttendanceComponents(mapping as ProviderAttendanceMapping);
      const dailyEarnings = daily.map((row) => {
        const date=String(row.work_date),attendanceDay=remainingAttendance.get(date);remainingAttendance.delete(date);
        const production=allocatedProductionBySource.get(`${mapping.id}:${String(row.id)}`)??[];
        const attendanceLines=(attendanceDay?.lines??[]).map(line=>({label:line.label,count:line.count,rate:line.rate,amount:line.amount}));
        const card = cardFor(mapping,date);
        const productionAmount=Math.round(production.reduce((sum:number,line:any)=>sum+line.amount,0)*100)/100;
        const baseAmount=attendanceConfigured?Math.round((productionAmount+(attendanceDay?.amount??0))*100)/100:productionConfigured?productionAmount:card?dailyCardAmounts.get(String(row.id))!:productionAmount;
        const incentiveAmount=incentives.bySource.get(String(row.id))??0;
        return { id:String(row.id),date,production:[...production,...attendanceLines],baseAmount,incentiveAmount,amount:Math.round((baseAmount+incentiveAmount)*100)/100,deliveries:metricValue(row,'total_delivery'),calculationSource:attendanceConfigured?'provider_attendance':productionConfigured?'provider_mapping':card?'workforce_rate_card':'provider_mapping',payType:attendanceConfigured?'attendance_eligibility':productionConfigured?'provider_mapping':card?.pay_type??'provider_mapping' };
      });
      for(const attendanceDay of remainingAttendance.values())dailyEarnings.push({id:attendanceDay.id,date:attendanceDay.date,production:attendanceDay.lines.map(line=>({label:line.label,count:line.count,rate:line.rate,amount:line.amount})),baseAmount:attendanceDay.amount,incentiveAmount:0,amount:attendanceDay.amount,deliveries:0,calculationSource:'provider_attendance',payType:'attendance_eligibility'});
      dailyEarnings.sort((left,right)=>right.date.localeCompare(left.date)||left.id.localeCompare(right.id));
      const attendanceProduction=new Map<string,{label:string;count:number;rate:number;amount:number}>();
      for(const day of attendanceDays)for(const line of day.lines){const key=`${line.code}:${line.rate}`,current=attendanceProduction.get(key)??{label:line.label,count:0,rate:line.rate,amount:0};current.count+=line.count;current.amount=Math.round((current.amount+line.amount)*100)/100;attendanceProduction.set(key,current);}
      const productionByKey=new Map<string,{label:string;count:number;rate:number;amount:number}>();
      for(const row of daily)for(const line of allocatedProductionBySource.get(`${mapping.id}:${String(row.id)}`)??[]){const key=`${line.label}:${line.rate}`,current=productionByKey.get(key)??{label:line.label,count:0,rate:line.rate,amount:0};current.count+=line.count;current.amount=Math.round((current.amount+line.amount)*100)/100;productionByKey.set(key,current);}
      const baseAmount = Math.round(dailyEarnings.reduce((sum: number, line) => sum + line.baseAmount, 0)*100)/100; const additions = Math.round(dailyEarnings.reduce((sum,line)=>sum+line.incentiveAmount,0)*100)/100;
      return { id: mapping.id, location: station?.station_code ?? "-", provider: first(mapping.providers)?.name ?? "-", model: station?.location_model_id ? "Mapped model" : "All models", paymentMethod: first(mapping.payment_methods)?.name ?? "-", workDays: new Set(dailyEarnings.map((row) => row.date)).size, production:[...productionByKey.values(),...attendanceProduction.values()], daily: dailyEarnings, baseAmount, additions, grossAmount: baseAmount + additions };
    });
    const directMethods=paymentMethodById(direct.methods);
    const directEarnings=direct.allocations.flatMap(allocation=>{
      const days=direct.days.filter(day=>day.allocationId===allocation.id);
      if(!days.length)return [];
      const productionByKey=new Map<string,{label:string;count:number;rate:number;amount:number}>();
      for(const day of days)for(const line of day.lines){const key=`${line.code}:${line.rate}`;const current=productionByKey.get(key)??{label:line.label,count:0,rate:line.rate,amount:0};current.count+=line.count;current.amount=Math.round((current.amount+line.amount)*100)/100;productionByKey.set(key,current);}
      const daily=days.map(day=>({id:day.id,date:day.date,production:day.lines.map(line=>({label:line.label,count:line.count,rate:line.rate,amount:line.amount})),baseAmount:day.amount,incentiveAmount:0,amount:day.amount,deliveries:0,calculationSource:'direct_allocation' as const,payType:'direct_allocation'}));
      const baseAmount=Math.round(days.reduce((sum,day)=>sum+day.amount,0)*100)/100;
      return [{id:allocation.id,location:allocation.station_code_snapshot??'-',provider:'Direct workforce',model:allocation.designation_name_snapshot??allocation.designation_code_snapshot??'-',paymentMethod:directMethods.get(allocation.payment_method_id)?.name??'-',workDays:days.filter(day=>day.workDayUnits>0).reduce((sum,day)=>sum+day.workDayUnits,0),production:[...productionByKey.values()],daily,baseAmount,additions:0,grossAmount:baseAmount}];
    });
    const earnings=[...providerEarnings,...directEarnings];
    const summary = earnings.reduce((total, row) => ({ workDays: total.workDays + row.workDays, baseAmount: total.baseAmount + row.baseAmount, additions: total.additions + row.additions, grossAmount: total.grossAmount + row.grossAmount }), { workDays: 0, baseAmount: 0, additions: 0, grossAmount: 0 });
    summary.workDays=new Set(providerEarnings.flatMap(row=>row.daily.map(day=>day.date))).size
      + directEarnings.reduce((total,row)=>total+row.workDays,0);
    summary.baseAmount=Math.round(summary.baseAmount*100)/100;
    // Posted adjustments remain part of this period's estimate exactly once. Statements are
    // a separate historical record, never added again and never treated as outstanding dues.
    summary.additions=adjustments.summary.additions;
    summary.grossAmount=Math.round((summary.baseAmount+incentives.summary.amount+summary.additions)*100)/100;
    const deductionAmount=adjustments.summary.deductions,netAmount=Math.round((summary.grossAmount-deductionAmount)*100)/100;
    return NextResponse.json({ month, earnings, adjustments, incentives:incentives.summary,summary:{...summary,incentiveAmount:incentives.summary.amount,deductionAmount,netAmount} }, { headers: { "Cache-Control": "private, no-store", "Vary":"Cookie" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load earnings." }, { status: 400,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"} }); }
}

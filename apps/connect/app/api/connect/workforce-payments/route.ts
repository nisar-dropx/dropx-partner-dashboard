import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePaymentReadPeriod } from "@/lib/workforce-payment-period";
import {paymentMappingForDay} from "@/lib/workforce-payment-mapping";
import { workforcePaymentStatus } from "@/lib/workforce-payment-status";
import {personalPaymentCard} from '@/lib/personal-payment-card';
import {allocateOwnDailyCards} from '@/lib/workforce-daily-card';
import {assertNoProviderDirectOverlap,type DirectPaymentComponent} from '@/lib/direct-workforce-payment';
import {attendanceIdentityFilter,loadDirectPaymentContext,loadDirectPaymentSetup,paymentMethodById,resolveCanonicalPaymentWorker} from '@/lib/direct-workforce-payment-data';
import {calculateProviderAttendancePayments,consumeProviderAttendanceAmount,hasProviderAttendanceComponents,type ProviderAttendanceMapping,type ProviderAttendanceMethod,type ProviderAttendanceRecord} from '@/lib/provider-attendance-payment';
import {
  aggregateShipmentDeliveriesByWorkforceDay,
  shipmentAttendanceRecord,
  workforceAttendanceCaptureSettingForDate
} from '../../../../../../src/lib/workforce-attendance-capture.ts';
export const dynamic='force-dynamic';

type Mapping = {
  id: string;
  payment_method_id?: string | null;
  pay_type?:string|null;
  workforce_id?: string | null;
  provider_member_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  payment_values: Record<string, unknown> | null;
  status?: string | null;
  providers?: { name?: string | null; code?:string|null } | Array<{ name?: string | null;code?:string|null }> | null;
  stations?: {station_code?:string|null} | Array<{station_code?:string|null}> | null;
  payment_methods?: (ProviderAttendanceMethod & { name?: string | null }) | Array<ProviderAttendanceMethod & { name?: string | null }> | null;
};

function relationName(value: Mapping["providers"] | Mapping["payment_methods"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name ?? null;
}

function previousDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function componentField(component: DirectPaymentComponent) {
  return Array.isArray(component.payment_fields) ? component.payment_fields[0] : component.payment_fields;
}

function productionMetric(row: Record<string, unknown>, source: string) {
  const value = (key: string) => Number(row[key] ?? 0);
  const normalized = source.trim().toLowerCase();
  if (["amazon_delivery", "amazondelivery"].includes(normalized)) return value("amazon_delivery");
  if (["swa_delivery", "swadelivery"].includes(normalized)) return value("swa_delivery");
  if (["total_delivery", "delivery"].includes(normalized)) return value("total_delivery") || value("amazon_delivery") + value("swa_delivery");
  if (["customer_return", "creturn", "c_return"].includes(normalized)) return value("c_return");
  if (["seller_pickup", "mfn"].includes(normalized)) return value("mfn");
  if (["seller_return", "mfn_return", "slller_return"].includes(normalized)) return value("mfn_return");
  return 0;
}

function mappedProductionAmount(mapping: Mapping, row: Record<string, unknown>) {
  const method = Array.isArray(mapping.payment_methods) ? mapping.payment_methods[0] : mapping.payment_methods;
  const values = mapping.payment_values ?? {};
  const total = (method?.payment_method_components ?? []).reduce((sum, component) => {
    const field = Array.isArray(component.payment_fields) ? component.payment_fields[0] : component.payment_fields;
    if (component.component_type !== "production" && field?.field_type !== "production" && field?.calculation_type !== "count_x_rate") return sum;
    const code = String(component.component_code || field?.code || "").trim();
    const rawRate = values[code] ?? Object.entries(values).find(([key]) => key.trim().toUpperCase() === code.toUpperCase())?.[1];
    const rate = Number(rawRate ?? 0);
    if (!Number.isFinite(rate) || rate < 0) throw new Error("Your provider production rate is invalid. Contact Workforce.");
    return sum + productionMetric(row, String(field?.calculation_source ?? code)) * rate;
  }, 0);
  return Math.round(total * 100) / 100;
}

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Payments are unavailable right now.");
    const admin = supabaseAdmin;
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") as "employee" | "workforce" | "field_executive" | "contractor" | "vendor" | "worker";
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce") throw new Error("This payment view is available in the Workforce workspace only.");
    if (!account.pageAccess.some(code => ["earnings", "rate_card"].includes(code))) return NextResponse.json({error:"Payments are not enabled for this account."},{status:403,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"}});

    const workforce = await resolveCanonicalPaymentWorker(account);
    const identityFilters:string[] = account.profileType==="workforce" ? [`workforce_id.eq.${account.id}`] : [];
    const legacyColumns:Record<string,string>={employee:"employee_id",contractor:"contractor_id",field_executive:"field_executive_id"};
    if(legacyColumns[account.profileType])identityFilters.push(`and(workforce_id.is.null,${legacyColumns[account.profileType]}.eq.${account.id})`);
    if (account.profileType === "workforce" && workforce?.source_profile_id && workforce.source_profile_type && legacyColumns[workforce.source_profile_type]) identityFilters.push(`and(workforce_id.is.null,${legacyColumns[workforce.source_profile_type]}.eq.${workforce.source_profile_id})`);

    const today = todayKolkata();
    const currentMonth = today.slice(0, 7);
    const month = request.nextUrl.searchParams.get("month") || currentMonth;
    const period = workforcePaymentReadPeriod(month, today);
    const currentPeriod = workforcePaymentReadPeriod(currentMonth, today);
    const loadMappings = (target: { from: string; to: string }) => admin.from("field_executive_provider_mappings")
      .select("id,provider_member_id,effective_from,effective_to,status,payment_method_id,payment_values,pay_type,providers(name,code),stations(station_code),payment_methods(id,name,payment_method_components(component_code,component_type,label,pay_schedule,sort_order,is_active,payment_fields(code,label,field_type,pay_schedule,calculation_type,calculation_source))),workforce_id,field_executive_id,contractor_id,employee_id")
      .eq("company_id", account.companyId)
      .neq("status", "cancelled").lt("effective_from",target.to).or(`effective_to.is.null,effective_to.gte.${target.from}`)
      .or(identityFilters.length ? identityFilters.join(","):"id.eq.00000000-0000-0000-0000-000000000000").order("effective_from",{ascending:false}).limit(1000);
    const mappingResult = await loadMappings(period);
    if (mappingResult.error) throw new Error("We could not load your payment mapping. Please try again.");

    if((mappingResult.data ?? []).length>=1000) throw new Error("Too many mapping versions to reconcile safely. Please contact Workforce.");
    const mappings = (mappingResult.data ?? []) as Mapping[];
    const periodEnd = previousDate(period.to);
    const direct = await loadDirectPaymentContext({companyId:account.companyId,workforceId:workforce?.id??null,from:period.from,to:periodEnd,employmentFrom:workforce?.date_of_join,employmentTo:workforce?.last_working_date,sourceProfileId:workforce?.source_profile_id,sourceProfileType:workforce?.source_profile_type});
    assertNoProviderDirectOverlap({allocations:direct.allocations,mappings,from:period.from,to:periodEnd});
    const currentMappingResult = month === currentMonth ? mappingResult : await loadMappings(currentPeriod);
    if (currentMappingResult.error) throw new Error("We could not load your current rate card. Please try again.");
    if ((currentMappingResult.data ?? []).length >= 1000) throw new Error("Too many current mapping versions to reconcile safely. Please contact Workforce.");
    const currentMappings = (currentMappingResult.data ?? []) as Mapping[];
    const currentEnd = today;
    const currentDirect = month === currentMonth
      ? direct
      : await loadDirectPaymentSetup({companyId:account.companyId,workforceId:workforce?.id??null,from:currentPeriod.from,to:currentEnd});
    assertNoProviderDirectOverlap({allocations:currentDirect.allocations,mappings:currentMappings,from:currentPeriod.from,to:currentEnd});
    const providerMemberIds = [...new Set(mappings.map((mapping) => mapping.provider_member_id).filter((id): id is string => Boolean(id)))];
    const [dailyResult,providerAttendanceResult] = await Promise.all([providerMemberIds.length
      ? supabaseAdmin.from("cps_shipment_daily")
        .select("id,work_date,station_code,client,provider_employee_id,provider_employee_name,total_activity,total_delivery,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,da_total_pay,del_rate,c_return_rate,mfn_rate,mfn_return_rate")
        .eq("company_id", account.companyId)
        .in("provider_employee_id", providerMemberIds)
        .gte("work_date", period.from)
        .lt("work_date", period.to)
        .order("work_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
      workforce?.id && mappings.length
        ? supabaseAdmin.from("attendance_daily").select("id,punch_date,status,in_time,out_time,work_minutes")
          .eq("company_id",account.companyId).or(attendanceIdentityFilter(workforce)).gte("punch_date",period.from).lte("punch_date",periodEnd).order("punch_date")
        : Promise.resolve({data:[],error:null})
    ]);
    if (dailyResult.error) throw new Error("We could not load your live earnings. Please try again.");
    if (providerAttendanceResult.error) throw new Error("We could not load the attendance used for your provider earnings. Please try again.");
    if ((providerAttendanceResult.data ?? []).length >= 1000) throw new Error("Too many attendance records to reconcile safely. Contact Workforce.");

    type RateLine = { code: string; label: string; count: number; rate: number; amount: number };
    type ProviderDay = { providerMemberId: string; providerMemberName: string | null; deliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Map<string, RateLine> };
    type Day = { date: string; deliveries: number; amazonDeliveries: number; swaDeliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Map<string, RateLine>; providers: Map<string, ProviderDay> };
    const mappedRate = (mapping: Mapping, storedRate: unknown, keys: string[]) => {
      const current = Number(mapping.payment_values?.DROPX_PERSONAL_TERMS)===1?0:Number(storedRate ?? 0);
      if (Number.isFinite(current) && current > 0) return current;
      const values = mapping.payment_values ?? {};
      for (const key of keys) {
        const candidate = Number(values[key] ?? 0);
        if (Number.isFinite(candidate) && candidate > 0) return candidate;
      }
      return 0;
    };
    const mergeLine = (target: Map<string, RateLine>, line: RateLine) => {
      const key = `${line.code}:${line.rate}`;
      const current = target.get(key) ?? { ...line, count: 0, amount: 0 };
      current.count += line.count;
      current.amount += line.amount;
      target.set(key, current);
    };
    const dailyByDate = new Map<string, Day>();
    const providerWorkDates = new Set<string>();
    const shipmentAttendanceByDay=aggregateShipmentDeliveriesByWorkforceDay((dailyResult.data??[]).flatMap(row=>{
      const date=String(row.work_date??'');
      return workforce?.id && paymentMappingForDay(mappings,row)
        ? [{workforce_id:workforce.id,work_date:date,total_delivery:Number(row.total_delivery??0)}]
        : [];
    }));
    const providerAttendance:ProviderAttendanceRecord[]=[...(providerAttendanceResult.data??[]).filter(row=>
      workforceAttendanceCaptureSettingForDate(direct.attendanceCaptureHistory,String(row.punch_date)).capture_method==='biometric'
    )];
    if(workforce?.id) for(const [workerDate,totalDeliveries] of shipmentAttendanceByDay) {
      const date=workerDate.slice(workforce.id.length+1);
      const capture=workforceAttendanceCaptureSettingForDate(direct.attendanceCaptureHistory,date);
      if(capture.capture_method==='shipment_data') providerAttendance.push({id:`shipment:${workforce.id}:${date}`,...shipmentAttendanceRecord(date,totalDeliveries,capture)});
    }
    const providerAttendanceDays=calculateProviderAttendancePayments({mappings:mappings as unknown as ProviderAttendanceMapping[],attendance:providerAttendance,policyHistory:direct.policyHistory,attendanceCaptureHistory:direct.attendanceCaptureHistory,from:period.from,to:periodEnd});
    const providerAttendanceByMappingDate=new Map(providerAttendanceDays.map(day=>[`${day.mappingId}|${day.date}`,day]));
    const consumedProviderAttendance=new Set<string>();
    const personalAmounts=allocateOwnDailyCards((dailyResult.data||[]).flatMap(row=>{const m=paymentMappingForDay(mappings,row),card=m?personalPaymentCard(m):null;return card?[{row,card}]:[];}));
    for (const row of dailyResult.data ?? []) {
      const mapping=paymentMappingForDay(mappings,row);
      if(!mapping) continue;
      const date = String(row.work_date ?? "");
      providerWorkDates.add(date);
      const deliveries = Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)));
      const cReturns = Number(row.c_return ?? 0);
      const mfn = Number(row.mfn ?? 0);
      const mfnReturns = Number(row.mfn_return ?? 0);
      const attendanceDay=providerAttendanceByMappingDate.get(`${mapping.id}|${date}`);
      const earnings = hasProviderAttendanceComponents(mapping as unknown as ProviderAttendanceMapping)
        ? Math.round((mappedProductionAmount(mapping,row as Record<string,unknown>)+consumeProviderAttendanceAmount(attendanceDay,consumedProviderAttendance))*100)/100
        : personalAmounts.get(row.id) ?? Number(row.da_total_pay ?? 0);
      const lines: RateLine[] = [
        { code: "delivery", label: "Delivery", count: deliveries, rate: mappedRate(mapping, row.del_rate, ["DELIVERY", "AMAZON_DELIVERY"]), amount: 0 },
        { code: "c_return", label: "C-return", count: cReturns, rate: mappedRate(mapping, row.c_return_rate, ["CRETURN", "C_RETURN", "CUSTOMER_RETURN"]), amount: 0 },
        { code: "mfn", label: "MFN", count: mfn, rate: mappedRate(mapping, row.mfn_rate, ["MFN", "SELLER_PICKUP"]), amount: 0 },
        { code: "mfn_return", label: "MFN return", count: mfnReturns, rate: mappedRate(mapping, row.mfn_return_rate, ["MFN_RETURN", "SELLER_RETURN", "SLLLER_RETURN"]), amount: 0 }
      ].map((line) => ({ ...line, amount: line.count * line.rate }));
      const current = dailyByDate.get(date) ?? { date, deliveries: 0, amazonDeliveries: 0, swaDeliveries: 0, cReturns: 0, mfn: 0, mfnReturns: 0, earnings: 0, rateLines: new Map<string, RateLine>(), providers: new Map<string, ProviderDay>() };
      current.deliveries += deliveries;
      current.amazonDeliveries += Number(row.amazon_delivery ?? 0);
      current.swaDeliveries += Number(row.swa_delivery ?? 0);
      current.cReturns += cReturns;
      current.mfn += mfn;
      current.mfnReturns += mfnReturns;
      current.earnings += earnings;
      lines.forEach((line) => mergeLine(current.rateLines, line));
      const providerMemberId = String(row.provider_employee_id ?? mapping.provider_member_id ?? "");
      const provider = current.providers.get(providerMemberId) ?? { providerMemberId, providerMemberName: row.provider_employee_name ? String(row.provider_employee_name) : null, deliveries: 0, cReturns: 0, mfn: 0, mfnReturns: 0, earnings: 0, rateLines: new Map<string, RateLine>() };
      provider.deliveries += deliveries;
      provider.cReturns += cReturns;
      provider.mfn += mfn;
      provider.mfnReturns += mfnReturns;
      provider.earnings += earnings;
      if (!provider.providerMemberName && row.provider_employee_name) provider.providerMemberName = String(row.provider_employee_name);
      lines.forEach((line) => mergeLine(provider.rateLines, line));
      current.providers.set(providerMemberId, provider);
      dailyByDate.set(date, current);
    }
    for(const attendanceDay of providerAttendanceDays){
      providerWorkDates.add(attendanceDay.date);
      const current=dailyByDate.get(attendanceDay.date)??{date:attendanceDay.date,deliveries:0,amazonDeliveries:0,swaDeliveries:0,cReturns:0,mfn:0,mfnReturns:0,earnings:0,rateLines:new Map<string,RateLine>(),providers:new Map<string,ProviderDay>()};
      current.earnings+=consumeProviderAttendanceAmount(attendanceDay,consumedProviderAttendance);
      attendanceDay.lines.forEach(line=>mergeLine(current.rateLines,{code:line.code,label:line.label,count:line.count,rate:line.rate,amount:line.amount}));
      dailyByDate.set(attendanceDay.date,current);
    }
    for (const directDay of direct.days) {
      const current = dailyByDate.get(directDay.date) ?? { date: directDay.date, deliveries: 0, amazonDeliveries: 0, swaDeliveries: 0, cReturns: 0, mfn: 0, mfnReturns: 0, earnings: 0, rateLines: new Map<string, RateLine>(), providers: new Map<string, ProviderDay>() };
      current.earnings += directDay.amount;
      directDay.lines.forEach((line) => mergeLine(current.rateLines, { code: line.code, label: line.label, count: line.count, rate: line.rate, amount: line.amount }));
      dailyByDate.set(directDay.date, current);
    }
    const daily = [...dailyByDate.values()].map((row) => ({ ...row, rateLines: [...row.rateLines.values()], providers: [...row.providers.values()].map((provider) => ({ ...provider, rateLines: [...provider.rateLines.values()] })).sort((left, right) => left.providerMemberId.localeCompare(right.providerMemberId)) })).sort((left, right) => right.date.localeCompare(left.date));
    const mtdLines = new Map<string, RateLine>();
    for (const day of daily) for (const line of day.rateLines) {
      const key = `${line.code}:${line.rate}`;
      const current = mtdLines.get(key) ?? { ...line, count: 0, amount: 0 };
      current.count += line.count;
      current.amount += line.amount;
      mtdLines.set(key, current);
    }
    const payrollItems = account.profileType === "workforce" && account.pageAccess.includes("earnings")
      ? await supabaseAdmin.from("workforce_payroll_items")
        .select("id,payroll_run_id,shipment_count,work_days,base_amount,incentive_amount,adjustment_amount,deduction_amount,gross_amount,net_amount,status")
        .eq("company_id", account.companyId).eq("workforce_id", account.id).order("created_at", { ascending: false }).limit(36)
      : { data: [], error: null };
    if (payrollItems.error) throw new Error("We could not load your payment statements. Please try again.");
    const runIds = [...new Set((payrollItems.data ?? []).map((row) => String(row.payroll_run_id)).filter(Boolean))];
    const payrollRuns = runIds.length
      ? await supabaseAdmin.from("workforce_payroll_runs")
        .select("id,run_number,period_start,period_end,status,payment_reference,payment_date,paid_at")
        .eq("company_id", account.companyId).in("id", runIds)
      : { data: [], error: null };
    if (payrollRuns.error) throw new Error("We could not load your payment statements. Please try again.");
    const itemIds = (payrollItems.data ?? []).map(item => item.id);
    const financePayments = itemIds.length
      ? await supabaseAdmin.from("payment_requests").select("source_id,status,processed_at,utr_cin")
        .eq("company_id",account.companyId).eq("source_system","WORKFORCE_PAYROLL").in("source_id",itemIds)
      : {data:[],error:null};
    if (financePayments.error) throw new Error("We could not load your payment reconciliation. Please try again.");
    const financeByItem = new Map((financePayments.data ?? []).map(payment=>[payment.source_id,payment]));
    const runsById = new Map((payrollRuns.data ?? []).map((row) => [row.id, row]));
    const statements = (payrollItems.data ?? []).flatMap((item) => {
      const run = runsById.get(item.payroll_run_id);
      if (!run) return [];
      const paymentStatus = workforcePaymentStatus(item,run,financeByItem.get(item.id));
      if (!paymentStatus) return [];
      return [{
        id: item.id, runNumber: run.run_number, periodStart: run.period_start, periodEnd: run.period_end,
        ...paymentStatus,
        shipments: Number(item.shipment_count ?? 0), workingDays: Number(item.work_days ?? 0), baseAmount: Number(item.base_amount ?? 0),
        incentiveAmount: Number(item.incentive_amount ?? 0), adjustmentAmount: Number(item.adjustment_amount ?? 0), deductionAmount: Number(item.deduction_amount ?? 0),
        grossAmount: Number(item.gross_amount ?? 0), netAmount: Number(item.net_amount ?? 0)
      }];
    });
    const providerRateCard = currentMappings.flatMap((mapping) => Object.entries(mapping.payment_values ?? {})
      .filter(([key, value]) => !key.startsWith('DROPX_') && Number.isFinite(Number(value)))
      .map(([code, value]) => ({ code, rate: Number(value), providerMemberId: mapping.provider_member_id, effectiveFrom: mapping.effective_from, effectiveTo: mapping.effective_to })));
    const currentDirectMethods=paymentMethodById(currentDirect.methods);
    const directRateCard=currentDirect.allocations.flatMap(allocation=>{
      const method=currentDirectMethods.get(allocation.payment_method_id);
      const snapshotComponents=Array.isArray(allocation.payment_components)
        ? allocation.payment_components.filter((component):component is DirectPaymentComponent=>Boolean(component&&typeof component==='object'))
        : [];
      const components=snapshotComponents.length?snapshotComponents:(method?.payment_method_components??[]).filter(component=>component.is_active!==false);
      return components.flatMap(component=>{
        const field=componentField(component),code=String(component.component_code||field?.code||'').trim();
        const raw=allocation.payment_values?.[code]??allocation.payment_values?.[component.component_code];
        const rate=Number(raw);
        return code&&Number.isFinite(rate)?[{code,label:String(field?.label||component.label||code),rate,providerMemberId:null,effectiveFrom:allocation.effective_from,effectiveTo:allocation.effective_to,source:'direct' as const}]:[];
      });
    });
    const directMapping=currentDirect.allocations.map(allocation=>({
      id:allocation.id,
      providerMemberId:null,
      provider:null,
      paymentMethod:currentDirectMethods.get(allocation.payment_method_id)?.name??null,
      effectiveFrom:allocation.effective_from,
      effectiveTo:allocation.effective_to,
      source:'direct' as const,
      station:allocation.station_code_snapshot??null
    }));
    const currentMappingPayload=[...currentMappings.map((mapping) => ({
      id: mapping.id,
      providerMemberId: mapping.provider_member_id,
      provider: relationName(mapping.providers),
      paymentMethod: relationName(mapping.payment_methods),
      effectiveFrom: mapping.effective_from,
      effectiveTo: mapping.effective_to,
      source:'provider' as const,
      station:null
    })),...directMapping].sort((left,right)=>String(right.effectiveFrom??'').localeCompare(String(left.effectiveFrom??'')));

    return NextResponse.json({
      month,
      period: period.label,
      hasPaymentMapping: mappings.length > 0 || direct.allocations.length > 0,
      mapping: currentMappingPayload,
      summary: account.pageAccess.includes("earnings") ? {
        deliveries: daily.reduce((total, row) => total + row.deliveries, 0),
        earnings: daily.reduce((total, row) => total + row.earnings, 0),
        workingDays: providerWorkDates.size + direct.days.reduce((total,day)=>total+day.workDayUnits,0),
        latestDate: daily[0]?.date ?? null,
        rateLines: [...mtdLines.values()]
      } : {deliveries:0,earnings:0,workingDays:0,latestDate:null,rateLines:[]},
      daily: account.pageAccess.includes("earnings") ? daily : [],
      statements,
      rateCard:[...providerRateCard,...directRateCard]
    }, { headers: { "Cache-Control": "private, no-store", "Vary":"Cookie" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load workforce payments." }, { status: 400,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"} });
  }
}

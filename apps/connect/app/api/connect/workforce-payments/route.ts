import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePaymentMonth } from "@/lib/workforce-payment-period";
import {paymentMappingForDay} from "@/lib/workforce-payment-mapping";
import { workforcePaymentStatus } from "@/lib/workforce-payment-status";
export const dynamic='force-dynamic';

type Mapping = {
  id: string;
  workforce_id?: string | null;
  provider_member_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  payment_values: Record<string, unknown> | null;
  providers?: { name?: string | null; code?:string|null } | Array<{ name?: string | null;code?:string|null }> | null;
  stations?: {station_code?:string|null} | Array<{station_code?:string|null}> | null;
  payment_methods?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

function relationName(value: Mapping["providers"] | Mapping["payment_methods"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name ?? null;
}

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Payments are unavailable right now.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") as "employee" | "workforce" | "field_executive" | "contractor" | "vendor" | "worker";
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce") throw new Error("This payment view is available in the Workforce workspace only.");
    if (!account.pageAccess.some(code => ["earnings", "rate_card"].includes(code))) return NextResponse.json({error:"Payments are not enabled for this account."},{status:403,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"}});

    const identityFilters:string[] = account.profileType==="workforce" ? [`workforce_id.eq.${account.id}`] : [];
    const legacyColumns:Record<string,string>={employee:"employee_id",contractor:"contractor_id",field_executive:"field_executive_id"};
    if(legacyColumns[account.profileType])identityFilters.push(`and(workforce_id.is.null,${legacyColumns[account.profileType]}.eq.${account.id})`);
    if (account.profileType === "workforce") {
      const source = await supabaseAdmin.from("workforce")
        .select("source_profile_id,source_profile_type")
        .eq("company_id", account.companyId)
        .eq("id", account.id)
        .maybeSingle();
      if(source.error) throw new Error("Your Workforce identity could not be verified.");
      if(source.data?.source_profile_id && legacyColumns[source.data.source_profile_type])identityFilters.push(`and(workforce_id.is.null,${legacyColumns[source.data.source_profile_type]}.eq.${source.data.source_profile_id})`);
    }

    const period = workforcePaymentMonth();
    const mappingResult = await supabaseAdmin.from("field_executive_provider_mappings")
      .select("id,provider_member_id,effective_from,effective_to,payment_values,providers(name,code),stations(station_code),payment_methods(name),workforce_id,field_executive_id,contractor_id,employee_id")
      .eq("company_id", account.companyId)
      .neq("status", "cancelled").lt("effective_from",period.to).or(`effective_to.is.null,effective_to.gte.${period.from}`)
      .or(identityFilters.length ? identityFilters.join(","):"id.eq.00000000-0000-0000-0000-000000000000").order("effective_from",{ascending:false}).limit(1000);
    if (mappingResult.error) throw new Error("We could not load your payment mapping. Please try again.");

    if((mappingResult.data ?? []).length>=1000) throw new Error("Too many mapping versions to reconcile safely. Please contact Workforce.");
    const mappings = (mappingResult.data ?? []) as Mapping[];
    const providerMemberIds = [...new Set(mappings.map((mapping) => mapping.provider_member_id).filter((id): id is string => Boolean(id)))];
    const dailyResult = providerMemberIds.length
      ? await supabaseAdmin.from("cps_shipment_daily")
        .select("work_date,station_code,client,provider_employee_id,provider_employee_name,total_delivery,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,da_total_pay,del_rate,c_return_rate,mfn_rate,mfn_return_rate")
        .eq("company_id", account.companyId)
        .in("provider_employee_id", providerMemberIds)
        .gte("work_date", period.from)
        .lt("work_date", period.to)
        .order("work_date", { ascending: false })
      : { data: [], error: null };
    if (dailyResult.error) throw new Error("We could not load your live earnings. Please try again.");

    type RateLine = { code: string; label: string; count: number; rate: number; amount: number };
    type ProviderDay = { providerMemberId: string; providerMemberName: string | null; deliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Map<string, RateLine> };
    type Day = { date: string; deliveries: number; amazonDeliveries: number; swaDeliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Map<string, RateLine>; providers: Map<string, ProviderDay> };
    const mappedRate = (mapping: Mapping, storedRate: unknown, keys: string[]) => {
      const current = Number(storedRate ?? 0);
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
    for (const row of dailyResult.data ?? []) {
      const mapping=paymentMappingForDay(mappings,row);
      if(!mapping) continue;
      const date = String(row.work_date ?? "");
      const deliveries = Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)));
      const cReturns = Number(row.c_return ?? 0);
      const mfn = Number(row.mfn ?? 0);
      const mfnReturns = Number(row.mfn_return ?? 0);
      const earnings = Number(row.da_total_pay ?? 0);
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
    const rateCard = mappings.flatMap((mapping) => Object.entries(mapping.payment_values ?? {})
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([code, value]) => ({ code, rate: Number(value), providerMemberId: mapping.provider_member_id, effectiveFrom: mapping.effective_from, effectiveTo: mapping.effective_to })));

    return NextResponse.json({
      period: period.label,
      mapping: mappings.map((mapping) => ({
        id: mapping.id,
        providerMemberId: mapping.provider_member_id,
        provider: relationName(mapping.providers),
        paymentMethod: relationName(mapping.payment_methods),
        effectiveFrom: mapping.effective_from,
        effectiveTo: mapping.effective_to
      })),
      summary: account.pageAccess.includes("earnings") ? {
        deliveries: daily.reduce((total, row) => total + row.deliveries, 0),
        earnings: daily.reduce((total, row) => total + row.earnings, 0),
        workingDays: daily.length,
        latestDate: daily[0]?.date ?? null,
        rateLines: [...mtdLines.values()]
      } : {deliveries:0,earnings:0,workingDays:0,latestDate:null,rateLines:[]},
      daily: account.pageAccess.includes("earnings") ? daily : [],
      statements,
      rateCard
    }, { headers: { "Cache-Control": "private, no-store", "Vary":"Cookie" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load workforce payments." }, { status: 400,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"} });
  }
}

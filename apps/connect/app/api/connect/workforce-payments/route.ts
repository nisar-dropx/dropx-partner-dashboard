import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Mapping = {
  id: string;
  workforce_id?: string | null;
  provider_member_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  payment_values: Record<string, unknown> | null;
  providers?: { name?: string | null } | Array<{ name?: string | null }> | null;
  payment_methods?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

function relationName(value: Mapping["providers"] | Mapping["payment_methods"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name ?? null;
}

function monthRange(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const to = `${year}-${String(month + 2).padStart(2, "0")}-01`;
  const label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(year, month, 1));
  return { from, to, label };
}

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Payments are unavailable right now.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") as "employee" | "workforce" | "field_executive" | "contractor" | "vendor" | "worker";
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce") throw new Error("This payment view is available in the Workforce workspace only.");

    const sourceIds = new Set([account.id]);
    if (account.profileType === "workforce") {
      const source = await supabaseAdmin.from("workforce")
        .select("source_profile_id")
        .eq("company_id", account.companyId)
        .eq("id", account.id)
        .maybeSingle();
      if (!source.error && source.data?.source_profile_id) sourceIds.add(String(source.data.source_profile_id));
    }

    const mappingResult = await supabaseAdmin.from("field_executive_provider_mappings")
      .select("id,provider_member_id,effective_from,effective_to,payment_values,providers(name),payment_methods(name),workforce_id,field_executive_id,contractor_id,employee_id")
      .eq("company_id", account.companyId)
      .eq("status", "active");
    if (mappingResult.error) throw new Error("We could not load your payment mapping. Please try again.");

    const mappings = ((mappingResult.data ?? []) as Array<Mapping & { field_executive_id?: string | null; contractor_id?: string | null; employee_id?: string | null }>)
      .filter((mapping) => [mapping.workforce_id, mapping.field_executive_id, mapping.contractor_id, mapping.employee_id].some((id) => id && sourceIds.has(String(id))));
    const providerMemberIds = [...new Set(mappings.map((mapping) => mapping.provider_member_id).filter((id): id is string => Boolean(id)))];
    const period = monthRange();
    const dailyResult = providerMemberIds.length
      ? await supabaseAdmin.from("cps_shipment_daily")
        .select("work_date,provider_employee_id,total_delivery,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,da_total_pay,del_rate,c_return_rate,mfn_rate,mfn_return_rate")
        .eq("company_id", account.companyId)
        .in("provider_employee_id", providerMemberIds)
        .gte("work_date", period.from)
        .lt("work_date", period.to)
        .order("work_date", { ascending: false })
      : { data: [], error: null };
    if (dailyResult.error) throw new Error("We could not load your live earnings. Please try again.");

    type RateLine = { code: string; label: string; count: number; rate: number; amount: number; sharedRate?: boolean };
    type Day = { date: string; deliveries: number; amazonDeliveries: number; swaDeliveries: number; cReturns: number; mfn: number; mfnReturns: number; earnings: number; rateLines: Map<string, RateLine> };
    const dailyByDate = new Map<string, Day>();
    for (const row of dailyResult.data ?? []) {
      const date = String(row.work_date ?? "");
      const current = dailyByDate.get(date) ?? { date, deliveries: 0, amazonDeliveries: 0, swaDeliveries: 0, cReturns: 0, mfn: 0, mfnReturns: 0, earnings: 0, rateLines: new Map<string, RateLine>() };
      current.deliveries += Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)));
      current.amazonDeliveries += Number(row.amazon_delivery ?? 0);
      current.swaDeliveries += Number(row.swa_delivery ?? 0);
      current.cReturns += Number(row.c_return ?? 0);
      current.mfn += Number(row.mfn ?? 0);
      current.mfnReturns += Number(row.mfn_return ?? 0);
      current.earnings += Number(row.da_total_pay ?? 0);
      const addLine = (code: string, label: string, count: number, rate: number, sharedRate = false) => {
        if (!count) return;
        const key = `${code}:${rate}`;
        const previous = current.rateLines.get(key) ?? { code, label, count: 0, rate, amount: 0, sharedRate };
        previous.count += count;
        previous.amount += count * rate;
        current.rateLines.set(key, previous);
      };
      const deliveryRate = Number(row.del_rate ?? 0);
      addLine("amazon_delivery", "Amazon delivery", Number(row.amazon_delivery ?? 0), deliveryRate);
      // The current Amazon feed supplies one SWA total. It uses the configured delivery
      // rate until the upstream file supplies separate SWA Prepaid / COD counts.
      addLine("swa_delivery", "SWA delivery", Number(row.swa_delivery ?? 0), deliveryRate, true);
      addLine("c_return", "C-return", Number(row.c_return ?? 0), Number(row.c_return_rate ?? 0));
      addLine("mfn", "MFN", Number(row.mfn ?? 0), Number(row.mfn_rate ?? 0));
      addLine("mfn_return", "MFN return", Number(row.mfn_return ?? 0), Number(row.mfn_return_rate ?? 0));
      dailyByDate.set(date, current);
    }
    const daily = [...dailyByDate.values()].map((row) => ({ ...row, rateLines: [...row.rateLines.values()] })).sort((left, right) => right.date.localeCompare(left.date));
    const payrollItems = account.profileType === "workforce"
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
    const runsById = new Map((payrollRuns.data ?? []).map((row) => [row.id, row]));
    const statements = (payrollItems.data ?? []).flatMap((item) => {
      const run = runsById.get(item.payroll_run_id);
      if (!run || !["approved", "paid"].includes(String(run.status))) return [];
      return [{
        id: item.id, runNumber: run.run_number, periodStart: run.period_start, periodEnd: run.period_end,
        status: run.status, paymentDate: run.payment_date ?? run.paid_at ?? null, paymentReference: run.payment_reference ?? null,
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
      summary: {
        deliveries: daily.reduce((total, row) => total + row.deliveries, 0),
        earnings: daily.reduce((total, row) => total + row.earnings, 0),
        workingDays: daily.length,
        latestDate: daily[0]?.date ?? null
      },
      daily,
      statements,
      rateCard
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load workforce payments." }, { status: 400 });
  }
}

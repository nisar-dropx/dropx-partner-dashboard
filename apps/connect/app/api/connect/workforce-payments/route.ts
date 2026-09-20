import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Mapping = {
  id: string;
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
      .select("id,provider_member_id,effective_from,effective_to,payment_values,providers(name),payment_methods(name),field_executive_id,contractor_id,employee_id")
      .eq("company_id", account.companyId)
      .eq("status", "active");
    if (mappingResult.error) throw new Error("We could not load your payment mapping. Please try again.");

    const mappings = ((mappingResult.data ?? []) as Array<Mapping & { field_executive_id?: string | null; contractor_id?: string | null; employee_id?: string | null }>)
      .filter((mapping) => [mapping.field_executive_id, mapping.contractor_id, mapping.employee_id].some((id) => id && sourceIds.has(String(id))));
    const providerMemberIds = [...new Set(mappings.map((mapping) => mapping.provider_member_id).filter((id): id is string => Boolean(id)))];
    const period = monthRange();
    const dailyResult = providerMemberIds.length
      ? await supabaseAdmin.from("cps_shipment_daily")
        .select("work_date,provider_employee_id,total_delivery,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,da_total_pay")
        .eq("company_id", account.companyId)
        .in("provider_employee_id", providerMemberIds)
        .gte("work_date", period.from)
        .lt("work_date", period.to)
        .order("work_date", { ascending: false })
      : { data: [], error: null };
    if (dailyResult.error) throw new Error("We could not load your live earnings. Please try again.");

    const dailyByDate = new Map<string, { date: string; deliveries: number; earnings: number }>();
    for (const row of dailyResult.data ?? []) {
      const date = String(row.work_date ?? "");
      const current = dailyByDate.get(date) ?? { date, deliveries: 0, earnings: 0 };
      current.deliveries += Number(row.total_delivery ?? (Number(row.amazon_delivery ?? 0) + Number(row.swa_delivery ?? 0)));
      current.earnings += Number(row.da_total_pay ?? 0);
      dailyByDate.set(date, current);
    }
    const daily = [...dailyByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
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
      rateCard
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load workforce payments." }, { status: 400 });
  }
}

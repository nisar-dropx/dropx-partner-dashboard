import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { providerMappingPageCodeForCurrentHost } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const pageCode = providerMappingPageCodeForCurrentHost();
  if (!pageCode) {
    return NextResponse.json({ error: "Provider mapping is unavailable on this host." }, { status: 403 });
  }
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, pageCode, "access")) {
    return NextResponse.json({ error: "Provider mapping access denied." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Database connection is not configured." }, { status: 503 });
  }

  const providerMemberId = new URL(request.url).searchParams.get("providerMemberId")?.trim() ?? "";
  if (!providerMemberId || providerMemberId.length > 100) {
    return NextResponse.json({ error: "Enter a valid Provider Member ID." }, { status: 400 });
  }

  const companyId = requireCompanyId(authorization);
  let lookup = supabaseAdmin
    .from("cps_shipment_daily")
    .select("provider_employee_name, work_date, station_code")
    .eq("company_id", companyId)
    .eq("provider_employee_id", providerMemberId);
  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  if (!allLocations) {
    const { data: stations, error: stationError } = await supabaseAdmin
      .from("stations")
      .select("station_code")
      .eq("company_id", companyId)
      .in("id", authorization.locationScopeIds);
    if (stationError) return NextResponse.json({ error: stationError.message }, { status: 500 });
    const stationCodes = (stations ?? []).map((station) => station.station_code).filter(Boolean);
    if (!stationCodes.length) return NextResponse.json({ name: null, workDate: null });
    lookup = lookup.in("station_code", stationCodes);
  }

  const { data, error } = await lookup
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    name: data?.provider_employee_name?.trim() || null,
    workDate: data?.work_date ?? null
  });
}

import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "provider_mapping", "access")) {
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
  const { data, error } = await supabaseAdmin
    .from("cps_shipment_daily")
    .select("provider_employee_name, work_date")
    .eq("company_id", companyId)
    .eq("provider_employee_id", providerMemberId)
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

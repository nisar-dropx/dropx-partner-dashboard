import { getAuthorization, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { NextResponse } from "next/server";

export async function POST() {
  const authorization = await getAuthorization();
  if (!authorization || !isCompanyOwner(authorization)) {
    return NextResponse.json({ error: "Owner access is required." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Database service access is not configured." }, { status: 503 });
  }

  const companyId = requireCompanyId(authorization);
  const completedPickers = await supabaseAdmin
    .from("workforce_pickers")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .ilike("designation", "picker")
    .eq("onboarding_status", "active")
    .eq("is_active", false)
    .select("id");
  if (completedPickers.error) {
    return NextResponse.json({ error: completedPickers.error.message }, { status: 500 });
  }

  const activePickerIds = await supabaseAdmin
    .from("workforce_pickers")
    .select("dropx_id")
    .eq("company_id", companyId)
    .ilike("designation", "picker")
    .eq("onboarding_status", "active")
    .eq("is_active", true);
  if (activePickerIds.error) {
    return NextResponse.json({ error: activePickerIds.error.message }, { status: 500 });
  }
  const authoritativeIds = new Set((activePickerIds.data ?? []).map((row) => String(row.dropx_id ?? "").trim().toUpperCase()).filter(Boolean));

  const legacyCandidates = await supabaseAdmin
    .from("contractors")
    .select("id, dropx_id")
    .eq("company_id", companyId)
    .ilike("designation", "picker")
    .eq("onboarding_status", "active")
    .is("deleted_at", null)
    .eq("is_active", false);
  if (legacyCandidates.error) {
    return NextResponse.json({ error: legacyCandidates.error.message }, { status: 500 });
  }
  const legacyIds = (legacyCandidates.data ?? [])
    .filter((row) => !authoritativeIds.has(String(row.dropx_id ?? "").trim().toUpperCase()))
    .map((row) => row.id);
  const activatedLegacy = legacyIds.length
    ? await supabaseAdmin.from("contractors").update({ is_active: true, updated_at: new Date().toISOString() }).in("id", legacyIds).select("id")
    : { data: [], error: null };
  if (activatedLegacy.error) {
    return NextResponse.json({ error: activatedLegacy.error.message }, { status: 500 });
  }

  return NextResponse.json({
    activatedPickerRecords: completedPickers.data?.length ?? 0,
    activatedLegacyRecords: activatedLegacy.data?.length ?? 0
  });
}

export async function GET() {
  const result = await POST();
  const payload = await result.json();
  return new Response(
    `<!doctype html><html><body><h1>Picker activation result</h1><pre>${JSON.stringify(payload)}</pre></body></html>`,
    { status: result.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

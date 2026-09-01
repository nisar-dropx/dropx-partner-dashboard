import { getAuthorization, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { NextResponse } from "next/server";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization || !isCompanyOwner(authorization)) {
    return new Response("Owner access is required.", { status: 403 });
  }
  if (!supabaseAdmin) return new Response("Database service access is not configured.", { status: 503 });

  const companyId = requireCompanyId(authorization);
  const designationResult = await supabaseAdmin
    .from("designations")
    .select("id, code, name")
    .eq("company_id", companyId)
    .ilike("name", "picker");
  if (designationResult.error) return new Response(designationResult.error.message, { status: 500 });
  const designationIds = (designationResult.data ?? []).map((row) => row.id);
  const designationValues = Array.from(new Set(
    (designationResult.data ?? []).flatMap((row) => [row.code, row.name]).filter(Boolean)
  ));
  if (!designationIds.length) return new Response("No Picker designation was found.", { status: 404 });

  const activated = await supabaseAdmin
    .from("workforce")
    .update({ is_active: true, synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .in("designation_id", designationIds)
    .eq("onboarding_status", "active")
    .is("deleted_at", null)
    .eq("is_active", false)
    .select("id");
  if (activated.error) return new Response(activated.error.message, { status: 500 });

  const activatedContractors = await supabaseAdmin
    .from("contractors")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .in("designation", designationValues)
    .eq("onboarding_status", "active")
    .is("deleted_at", null)
    .eq("is_active", false)
    .select("id");
  if (activatedContractors.error) return new Response(activatedContractors.error.message, { status: 500 });

  return new Response(
    `<!doctype html><html><body><h1>Picker activation complete</h1><p>Activated ${activated.data?.length ?? 0} canonical and ${activatedContractors.data?.length ?? 0} People contractor records.</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export async function POST() {
  return NextResponse.json({ error: "Use the owner-confirmed activation page." }, { status: 405 });
}

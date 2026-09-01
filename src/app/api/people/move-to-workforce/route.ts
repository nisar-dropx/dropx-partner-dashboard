import { NextResponse } from "next/server";
import { getAuthorization, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SourceRegister = "contractors" | "employees";

type SourceProfile = Record<string, unknown> & {
  designation?: string | null;
  designation_id?: string | null;
  dropx_id?: string | null;
  employee_code?: string | null;
  id: string;
  is_active?: boolean | null;
};

function normalizedIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => String(item ?? "").trim().toUpperCase())
    .filter((item) => /^[A-Z0-9_-]{2,40}$/.test(item))))
    .slice(0, 25);
}

async function designationId(companyId: string, profile: SourceProfile) {
  const existing = String(profile.designation_id ?? "").trim();
  if (existing) return existing;
  const designation = String(profile.designation ?? "").trim();
  if (!designation) throw new Error("The source profile has no designation.");
  const result = await supabaseAdmin!.from("designations")
    .select("id, code, name")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (result.error) throw new Error(result.error.message);
  const normalized = designation.toLowerCase();
  const match = (result.data ?? []).find((row) => String(row.name ?? "").trim().toLowerCase() === normalized
    || String(row.code ?? "").trim().toLowerCase() === normalized);
  if (!match?.id) throw new Error(`Designation '${designation}' was not found in Designation Master.`);
  return String(match.id);
}

async function sourceProfile(companyId: string, dropxId: string) {
  const contractor = await supabaseAdmin!.from("contractors")
    .select("*")
    .eq("company_id", companyId)
    .ilike("dropx_id", dropxId)
    .limit(1)
    .maybeSingle();
  if (contractor.error) throw new Error(contractor.error.message);
  if (contractor.data) return { register: "contractors" as const, profile: contractor.data as SourceProfile };

  const employee = await supabaseAdmin!.from("employees")
    .select("*")
    .eq("company_id", companyId)
    .ilike("employee_code", dropxId)
    .limit(1)
    .maybeSingle();
  if (employee.error) throw new Error(employee.error.message);
  if (employee.data) return { register: "employees" as const, profile: employee.data as SourceProfile };
  return null;
}

async function existingWorkforceProfile(companyId: string, dropxId: string) {
  const result = await supabaseAdmin!.from("workforce")
    .select("id, dropx_id, source_profile_type, source_profile_id, is_active, migration_state")
    .eq("company_id", companyId)
    .ilike("dropx_id", dropxId)
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function POST(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!isCompanyOwner(authorization)) {
      return NextResponse.json({ error: "Only the company owner can move People records between categories." }, { status: 403 });
    }
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const companyId = requireCompanyId(authorization);
    const contentType = request.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await request.json() as { ids?: unknown; apply?: unknown; operation?: unknown }
      : await request.formData().then((formData) => ({
        ids: String(formData.get("ids") ?? "").split(/[\s,]+/),
        apply: formData.get("apply") === "true",
        operation: formData.get("operation")
      }));
    const ids = normalizedIds(body.ids);
    if (!ids.length) return NextResponse.json({ error: "Provide at least one valid DropX ID." }, { status: 400 });
    const apply = body.apply === true;
    if (body.operation === "remove_delivery_executive_duplicates") {
      return NextResponse.json({
        error: "The legacy Field Executives register has been retired. Workforce is now the only register, so duplicate cleanup is no longer required."
      }, { status: 410 });
    }
    const results: Array<Record<string, unknown>> = [];

    for (const dropxId of ids) {
      const source = await sourceProfile(companyId, dropxId);
      const existingWorkforce = await existingWorkforceProfile(companyId, dropxId);
      if (!source) {
        results.push({ dropxId, status: existingWorkforce ? "already_in_workforce" : "not_found", workforce: existingWorkforce });
        continue;
      }
      if (!apply) {
        results.push({
          dropxId,
          status: "ready",
          sourceRegister: source.register,
          sourceProfileId: source.profile.id,
          sourceActive: source.profile.is_active !== false,
          workforce: existingWorkforce
        });
        continue;
      }

      const resolvedDesignationId = await designationId(companyId, source.profile);
      const moved = await supabaseAdmin.rpc("route_profile_record", {
        p_source_register: source.register satisfies SourceRegister,
        p_record: source.profile,
        p_designation_id: resolvedDesignationId,
        p_target_register: "workforce"
      });
      if (moved.error) throw new Error(`${dropxId}: ${moved.error.message}`);
      results.push({
        dropxId,
        status: "moved",
        sourceRegister: source.register,
        sourceProfileId: source.profile.id,
        workforceProfileId: moved.data
      });
    }

    return NextResponse.json({ applied: apply, results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to move People records." }, { status: 500 });
  }
}

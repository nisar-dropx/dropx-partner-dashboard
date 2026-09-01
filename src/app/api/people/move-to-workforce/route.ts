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
    const body = await request.json() as { ids?: unknown; apply?: unknown; operation?: unknown };
    const ids = normalizedIds(body.ids);
    if (!ids.length) return NextResponse.json({ error: "Provide at least one valid DropX ID." }, { status: 400 });
    const apply = body.apply === true;
    if (body.operation === "remove_delivery_executive_duplicates") {
      const [workforceResult, deliveryExecutiveResult] = await Promise.all([
        supabaseAdmin.from("workforce")
          .select("id, dropx_id, onboarding_status, lifecycle_status, provider_id_status, is_active")
          .eq("company_id", companyId)
          .in("dropx_id", ids),
        supabaseAdmin.from("field_executives")
          .select("id, dropx_id, full_name, onboarding_status, is_active")
          .eq("company_id", companyId)
          .in("dropx_id", ids)
      ]);
      if (workforceResult.error) throw new Error(workforceResult.error.message);
      if (deliveryExecutiveResult.error) throw new Error(deliveryExecutiveResult.error.message);

      const workforceRows = workforceResult.data ?? [];
      const deliveryExecutiveRows = deliveryExecutiveResult.data ?? [];
      const workforceCodes = new Set(workforceRows.map((row) => String(row.dropx_id ?? "").toUpperCase()));
      const deliveryExecutiveCodes = new Set(deliveryExecutiveRows.map((row) => String(row.dropx_id ?? "").toUpperCase()));
      const missingWorkforce = ids.filter((id) => !workforceCodes.has(id));
      const missingDeliveryExecutives = ids.filter((id) => !deliveryExecutiveCodes.has(id));
      if (missingWorkforce.length || missingDeliveryExecutives.length) {
        return NextResponse.json({
          error: "The cleanup was not applied because both category records were not found for every requested ID.",
          missingWorkforce,
          missingDeliveryExecutives,
          workforce: workforceRows,
          deliveryExecutives: deliveryExecutiveRows
        }, { status: 409 });
      }
      if (!apply) {
        return NextResponse.json({ applied: false, status: "ready", workforce: workforceRows, deliveryExecutives: deliveryExecutiveRows });
      }

      const workforceIds = workforceRows.map((row) => row.id);
      const deliveryExecutiveIds = deliveryExecutiveRows.map((row) => row.id);
      const updateResult = await supabaseAdmin.from("workforce")
        .update({
          onboarding_status: "pending",
          lifecycle_status: "onboarding",
          provider_id_status: "pending",
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .eq("company_id", companyId)
        .in("id", workforceIds)
        .select("id, dropx_id, onboarding_status, lifecycle_status, provider_id_status, is_active");
      if (updateResult.error) throw new Error(updateResult.error.message);

      const deleteResult = await supabaseAdmin.from("field_executives")
        .delete()
        .eq("company_id", companyId)
        .in("id", deliveryExecutiveIds)
        .select("id, dropx_id");
      if (deleteResult.error) throw new Error(deleteResult.error.message);

      await supabaseAdmin.from("person_register_links")
        .delete()
        .eq("company_id", companyId)
        .eq("source_register", "field_executives")
        .in("source_profile_id", deliveryExecutiveIds);

      return NextResponse.json({
        applied: true,
        status: "completed",
        workforce: updateResult.data ?? [],
        deletedDeliveryExecutives: deleteResult.data ?? []
      });
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

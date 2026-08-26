"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  assignEmployeeToPosition,
  currentPositionOccupant,
  endPositionAssignment,
  recordPositionEvent
} from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function required(value: FormDataEntryValue | null, label: string) {
  const result = clean(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function locationIds(formData: FormData) {
  const raw = clean(formData.get("location_scope_ids"));
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? Array.from(new Set(parsed.map(String).filter(Boolean))) : [];
}

function positionsRedirect(message: { error?: string; notice?: string }): never {
  redirect(`/users/positions?${new URLSearchParams(message).toString()}`);
}

function isNextRedirect(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

export async function savePosition(formData: FormData) {
  const authorization = await requirePagePermission("users", clean(formData.get("id")) ? "edit" : "add");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) positionsRedirect({ error: "Database service is not configured." });

  try {
    const id = clean(formData.get("id")) || null;
    const code = required(formData.get("code"), "Position code").toUpperCase().replace(/[^A-Z0-9_-]+/g, "-");
    const name = required(formData.get("name"), "Position name");
    const roleId = required(formData.get("role_id"), "Access role");
    const designationId = clean(formData.get("designation_id")) || null;
    const reportsToPositionId = clean(formData.get("reports_to_position_id")) || null;
    const locationAccessMode = clean(formData.get("location_access_mode")) === "all_locations" ? "all_locations" : "selected";
    const scopeIds = locationIds(formData);
    if (reportsToPositionId && reportsToPositionId === id) throw new Error("A position cannot report to itself.");
    if (locationAccessMode === "selected" && !scopeIds.length) throw new Error("Select at least one location for this position.");

    const [roleResult, designationResult, parentResult, locationsResult] = await Promise.all([
      supabaseAdmin.from("user_roles").select("id").eq("id", roleId).eq("company_id", companyId).eq("is_active", true).maybeSingle(),
      designationId
        ? supabaseAdmin.from("designations").select("id").eq("id", designationId).eq("company_id", companyId).eq("is_active", true).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      reportsToPositionId
        ? supabaseAdmin.from("org_positions").select("id, reports_to_position_id").eq("id", reportsToPositionId).eq("company_id", companyId).eq("is_active", true).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      scopeIds.length
        ? supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("is_active", true).in("id", scopeIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    const lookupError = [roleResult.error, designationResult.error, parentResult.error, locationsResult.error].find(Boolean);
    if (lookupError) throw new Error(lookupError.message);
    if (!roleResult.data) throw new Error("Selected access role is not available.");
    if (designationId && !designationResult.data) throw new Error("Selected designation is not available.");
    if (reportsToPositionId && !parentResult.data) throw new Error("Reporting position is not available.");
    if (locationAccessMode === "selected" && (locationsResult.data ?? []).length !== scopeIds.length) {
      throw new Error("One or more selected locations are not available.");
    }

    if (id && reportsToPositionId) {
      const visited = new Set([id]);
      let cursor: string | null = reportsToPositionId;
      while (cursor) {
        if (visited.has(cursor)) throw new Error("This reporting setup would create a loop.");
        visited.add(cursor);
        const parentLookup: { data: { reports_to_position_id: string | null } | null; error: { message: string } | null } = await supabaseAdmin.from("org_positions").select("reports_to_position_id")
          .eq("id", cursor).eq("company_id", companyId).maybeSingle();
        if (parentLookup.error) throw new Error(parentLookup.error.message);
        cursor = parentLookup.data?.reports_to_position_id ?? null;
      }
    }

    const payload = {
      company_id: companyId,
      code,
      name,
      designation_id: designationId,
      role_id: roleId,
      reports_to_position_id: reportsToPositionId,
      location_access_mode: locationAccessMode,
      location_scope_ids: locationAccessMode === "all_locations" ? [] : scopeIds,
      is_active: true,
      updated_at: new Date().toISOString()
    };
    const result = id
      ? await supabaseAdmin.from("org_positions").update(payload).eq("id", id).eq("company_id", companyId).select("id").single()
      : await supabaseAdmin.from("org_positions").insert({ ...payload, created_by: authorization.userId }).select("id").single();
    if (result.error) {
      if (result.error.message.toLowerCase().includes("duplicate")) throw new Error("Position code already exists.");
      throw new Error(result.error.message);
    }

    const positionId = result.data.id as string;
    if (id) {
      const occupant = await currentPositionOccupant(companyId, positionId);
      if (occupant?.assignment_type === "permanent") {
        const managerProfileId = reportsToPositionId
          ? (await currentPositionOccupant(companyId, reportsToPositionId))?.profile_id ?? null
          : null;
        const profileUpdate = await supabaseAdmin.from("profiles").update({
          role_id: roleId,
          reports_to_user_id: managerProfileId,
          location_scope_ids: locationAccessMode === "all_locations" ? [] : scopeIds
        }).eq("id", occupant.profile_id).eq("company_id", companyId);
        if (profileUpdate.error) throw new Error(profileUpdate.error.message);
      }
    }

    await recordPositionEvent({
      actorUserId: authorization.userId,
      companyId,
      details: { code, name },
      eventType: id ? "position_updated" : "position_created",
      positionId
    });
    revalidatePath("/users/positions");
    positionsRedirect({ notice: id ? "Position updated." : "Position created." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    positionsRedirect({ error: error instanceof Error ? error.message : "Unable to save position." });
  }
}

export async function assignPermanentPosition(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    await assignEmployeeToPosition({
      actorUserId: authorization.userId,
      companyId,
      employeeId: required(formData.get("employee_id"), "Employee"),
      positionId: required(formData.get("position_id"), "Position"),
      assignmentType: "permanent",
      reason: clean(formData.get("reason")) || "Position assignment"
    });
    revalidatePath("/users/positions");
    revalidatePath("/employees");
    positionsRedirect({ notice: "Position assigned. Portal access now follows this position." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    positionsRedirect({ error: error instanceof Error ? error.message : "Unable to assign position." });
  }
}

export async function assignActingCover(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    const validFrom = required(formData.get("valid_from"), "Start date");
    const validUntil = required(formData.get("valid_until"), "End date");
    await assignEmployeeToPosition({
      actorUserId: authorization.userId,
      companyId,
      employeeId: required(formData.get("employee_id"), "Covering employee"),
      positionId: required(formData.get("position_id"), "Position"),
      assignmentType: "acting",
      reason: required(formData.get("reason"), "Reason"),
      validFrom,
      validUntil
    });
    revalidatePath("/users/positions");
    positionsRedirect({ notice: "Temporary cover scheduled. Access switches automatically for these dates." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    positionsRedirect({ error: error instanceof Error ? error.message : "Unable to schedule temporary cover." });
  }
}

export async function endAssignment(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    await endPositionAssignment({
      actorUserId: authorization.userId,
      assignmentId: required(formData.get("assignment_id"), "Assignment"),
      companyId
    });
    revalidatePath("/users/positions");
    revalidatePath("/employees");
    positionsRedirect({ notice: "Assignment ended and previous access restored." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    positionsRedirect({ error: error instanceof Error ? error.message : "Unable to end assignment." });
  }
}

export async function setPositionStatus(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) positionsRedirect({ error: "Database service is not configured." });
  try {
    const positionId = required(formData.get("position_id"), "Position");
    const nextActive = clean(formData.get("is_active")) === "true";
    if (!nextActive) {
      const assignmentCount = await supabaseAdmin.from("position_assignments")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId).eq("position_id", positionId).eq("is_active", true);
      if (assignmentCount.error) throw new Error(assignmentCount.error.message);
      if ((assignmentCount.count ?? 0) > 0) throw new Error("End active assignments before deactivating this position.");
    }
    const result = await supabaseAdmin.from("org_positions").update({ is_active: nextActive, updated_at: new Date().toISOString() })
      .eq("id", positionId).eq("company_id", companyId);
    if (result.error) throw new Error(result.error.message);
    await recordPositionEvent({ actorUserId: authorization.userId, companyId, eventType: nextActive ? "position_activated" : "position_deactivated", positionId });
    revalidatePath("/users/positions");
    positionsRedirect({ notice: nextActive ? "Position activated." : "Position deactivated." });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    positionsRedirect({ error: error instanceof Error ? error.message : "Unable to change position status." });
  }
}

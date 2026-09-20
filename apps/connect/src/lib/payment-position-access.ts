import { supabaseAdmin } from "./supabase-admin";

/**
 * Mirrors src/lib/position-access.ts (findPositionApprover,
 * roleIdsWithPageEditAccess, isMissingPositionAccessSchema) in the root
 * dashboard app. apps/connect is a separately-deployed Next.js app and
 * cannot import across app boundaries, so the payment-approval-steps engine
 * and its dependencies are duplicated here, same as HRMS's own
 * approval-workflow-routing.ts is already duplicated across three places in
 * this codebase. Keep in sync by hand if either copy's routing logic changes.
 */

type AssignmentRow = {
  id: string;
  position_id: string;
  profile_id: string;
  assignment_type: "permanent" | "acting";
  valid_from: string;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
};

function dateOnly(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function activeOnDate(assignment: Pick<AssignmentRow, "is_active" | "valid_from" | "valid_until">, day: string) {
  return assignment.is_active && assignment.valid_from <= day && (!assignment.valid_until || assignment.valid_until >= day);
}

export function isMissingPositionAccessSchema(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("org_positions") ||
    message.includes("position_assignments") ||
    message.includes("org_position_id")
  ) && (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("could not find")
  );
}

export async function findPositionApprover(
  companyId: string,
  roleIds: string[],
  locationId?: string | null,
  at = new Date()
) {
  if (!supabaseAdmin || !roleIds.length) return null;
  const positionsResult = await supabaseAdmin
    .from("org_positions")
    .select("id, role_id, location_access_mode, location_scope_ids")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("role_id", roleIds);
  if (positionsResult.error) {
    if (isMissingPositionAccessSchema(positionsResult.error)) return null;
    throw new Error(positionsResult.error.message);
  }
  const positions = (positionsResult.data ?? []).filter((position) => (
    !locationId ||
    position.location_access_mode === "all_locations" ||
    (position.location_scope_ids ?? []).includes(locationId)
  ));
  if (!positions.length) return null;

  const assignmentResult = await supabaseAdmin
    .from("position_assignments")
    .select("id, position_id, profile_id, assignment_type, valid_from, valid_until, is_active, created_at")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("position_id", positions.map((position) => position.id));
  if (assignmentResult.error) throw new Error(assignmentResult.error.message);
  const day = dateOnly(at);
  const activeAssignments = ((assignmentResult.data ?? []) as AssignmentRow[])
    .filter((assignment) => activeOnDate(assignment, day))
    .sort((left, right) => {
      if (left.assignment_type !== right.assignment_type) return left.assignment_type === "acting" ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    });
  const positionById = new Map(positions.map((position) => [position.id, position]));
  for (const assignment of activeAssignments) {
    const position = positionById.get(assignment.position_id);
    if (!position) continue;
    const profile = await supabaseAdmin
      .from("profiles")
      .select("id, is_active")
      .eq("id", assignment.profile_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (profile.data?.is_active) return { userId: profile.data.id as string, roleId: position.role_id as string };
  }
  return null;
}

export async function roleIdsWithPageEditAccess(companyId: string, roleIds: string[], pageCode: string): Promise<Set<string>> {
  if (!supabaseAdmin || !roleIds.length) return new Set();

  const rolesResult = await supabaseAdmin
    .from("user_roles")
    .select("id, code")
    .eq("company_id", companyId)
    .in("id", roleIds);
  if (rolesResult.error) return new Set(roleIds);
  const ownerRoleIds = (rolesResult.data ?? [])
    .filter((role) => String(role.code ?? "").trim().toUpperCase() === "OWNER")
    .map((role) => role.id);

  let pageResult = await supabaseAdmin
    .from("app_pages")
    .select("id")
    .eq("company_id", companyId)
    .eq("code", pageCode)
    .maybeSingle();
  if (!pageResult.data) {
    pageResult = await supabaseAdmin.from("app_pages").select("id").eq("code", pageCode).is("company_id", null).maybeSingle();
  }
  const pageId = pageResult.data?.id;
  if (!pageId) return new Set(roleIds);

  const grantsResult = await supabaseAdmin
    .from("role_page_permissions")
    .select("role_id, can_edit")
    .eq("company_id", companyId)
    .eq("page_id", pageId)
    .in("role_id", roleIds);
  if (grantsResult.error) return new Set(roleIds);

  const editableRoleIds = (grantsResult.data ?? [])
    .filter((grant) => grant.can_edit)
    .map((grant) => grant.role_id);

  return new Set([...ownerRoleIds, ...editableRoleIds]);
}

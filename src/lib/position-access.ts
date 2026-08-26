import { supabaseAdmin } from "@/lib/supabase-admin";

export type PositionAccess = {
  hasAllLocationAccess: boolean;
  locationScopeIds: string[];
  primaryPositionId: string | null;
  primaryRoleId: string | null;
  roleIds: string[];
};

type PositionRow = {
  id: string;
  role_id: string;
  reports_to_position_id: string | null;
  location_access_mode: "selected" | "all_locations";
  location_scope_ids: string[] | null;
  is_active: boolean;
};

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

function normalizedEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
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

export async function loadEffectivePositionAccess(
  companyId: string,
  profileId: string,
  at = new Date()
): Promise<PositionAccess> {
  const empty: PositionAccess = {
    hasAllLocationAccess: false,
    locationScopeIds: [],
    primaryPositionId: null,
    primaryRoleId: null,
    roleIds: []
  };
  if (!supabaseAdmin) return empty;

  const assignmentsResult = await supabaseAdmin
    .from("position_assignments")
    .select("id, position_id, profile_id, assignment_type, valid_from, valid_until, is_active, created_at")
    .eq("company_id", companyId)
    .eq("profile_id", profileId)
    .eq("is_active", true);
  if (assignmentsResult.error) {
    if (isMissingPositionAccessSchema(assignmentsResult.error)) return empty;
    throw new Error(assignmentsResult.error.message);
  }

  const day = dateOnly(at);
  const activeAssignments = (assignmentsResult.data ?? []).filter((assignment) => activeOnDate(assignment as AssignmentRow, day));
  if (!activeAssignments.length) return empty;

  const positionIds = Array.from(new Set(activeAssignments.map((assignment) => assignment.position_id)));
  const positionsResult = await supabaseAdmin
    .from("org_positions")
    .select("id, role_id, reports_to_position_id, location_access_mode, location_scope_ids, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", positionIds);
  if (positionsResult.error) {
    if (isMissingPositionAccessSchema(positionsResult.error)) return empty;
    throw new Error(positionsResult.error.message);
  }

  const positionsById = new Map((positionsResult.data ?? []).map((position) => [position.id, position as PositionRow]));
  const effectiveAssignments = activeAssignments.filter((assignment) => positionsById.has(assignment.position_id));
  const primaryAssignment = [...effectiveAssignments].sort((left, right) => {
    if (left.assignment_type !== right.assignment_type) return left.assignment_type === "acting" ? -1 : 1;
    if (left.valid_from !== right.valid_from) return right.valid_from.localeCompare(left.valid_from);
    return right.created_at.localeCompare(left.created_at);
  })[0];
  const locationScopeIds = Array.from(new Set(effectiveAssignments.flatMap((assignment) => (
    positionsById.get(assignment.position_id)?.location_scope_ids ?? []
  ))));
  const roleIds = Array.from(new Set(effectiveAssignments.map((assignment) => positionsById.get(assignment.position_id)?.role_id).filter(Boolean))) as string[];
  const primaryPosition = primaryAssignment ? positionsById.get(primaryAssignment.position_id) : null;

  return {
    hasAllLocationAccess: effectiveAssignments.some((assignment) => positionsById.get(assignment.position_id)?.location_access_mode === "all_locations"),
    locationScopeIds,
    primaryPositionId: primaryPosition?.id ?? null,
    primaryRoleId: primaryPosition?.role_id ?? null,
    roleIds
  };
}

export async function currentPositionOccupant(
  companyId: string,
  positionId: string,
  at = new Date()
) {
  if (!supabaseAdmin) return null;
  const result = await supabaseAdmin
    .from("position_assignments")
    .select("id, profile_id, assignment_type, valid_from, valid_until, is_active, created_at")
    .eq("company_id", companyId)
    .eq("position_id", positionId)
    .eq("is_active", true);
  if (result.error) {
    if (isMissingPositionAccessSchema(result.error)) return null;
    throw new Error(result.error.message);
  }
  const day = dateOnly(at);
  return ((result.data ?? []) as AssignmentRow[])
    .filter((assignment) => activeOnDate(assignment, day))
    .sort((left, right) => {
      if (left.assignment_type !== right.assignment_type) return left.assignment_type === "acting" ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    })[0] ?? null;
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

async function findAuthUserIdByEmail(email: string) {
  if (!supabaseAdmin) return null;
  for (let page = 1; page <= 20; page += 1) {
    const result = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (result.error) throw new Error(result.error.message);
    const match = result.data.users.find((user) => normalizedEmail(user.email) === email);
    if (match) return match.id;
    if (result.data.users.length < 100) break;
  }
  return null;
}

async function ensureEmployeeProfile(companyId: string, employeeId: string, assignmentType: "permanent" | "acting") {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const employeeResult = await supabaseAdmin
    .from("employees")
    .select("id, employee_code, full_name, email, mobile_country_code, mobile, location_id, designation_id, org_position_id, is_active, profile_completion_status")
    .eq("id", employeeId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (employeeResult.error) throw new Error(employeeResult.error.message);
  const employee = employeeResult.data;
  if (!employee) throw new Error("Employee was not found.");
  if (!employee.is_active || String(employee.profile_completion_status ?? "active").toLowerCase() !== "active") {
    throw new Error("Activate the employee profile before assigning portal access.");
  }
  const email = normalizedEmail(employee.email);
  if (!email) throw new Error("Add a work email to this employee before assigning a position.");

  const existingProfile = await supabaseAdmin
    .from("profiles")
    .select("id, company_id, invite_method")
    .ilike("email", email)
    .eq("company_id", companyId)
    .maybeSingle();
  if (existingProfile.error) throw new Error(existingProfile.error.message);
  if (existingProfile.data?.company_id && existingProfile.data.company_id !== companyId) {
    throw new Error("This email is already linked to another company.");
  }

  let profileId = existingProfile.data?.id as string | undefined;
  if (!profileId) profileId = await findAuthUserIdByEmail(email) ?? undefined;
  if (!profileId) {
    const invite = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { company_id: companyId, full_name: employee.full_name }
    });
    if (invite.error) throw new Error(`Unable to invite ${email}: ${invite.error.message}`);
    profileId = invite.data.user.id;
  }

  const profileOwner = await supabaseAdmin.from("profiles").select("company_id, invite_method").eq("id", profileId).maybeSingle();
  if (profileOwner.error) throw new Error(profileOwner.error.message);
  if (profileOwner.data?.company_id && profileOwner.data.company_id !== companyId) {
    throw new Error("This login already belongs to another company.");
  }

  const profileResult = await supabaseAdmin.from("profiles").upsert({
    id: profileId,
    company_id: companyId,
    employee_id: employee.employee_code,
    full_name: employee.full_name,
    email,
    mobile_country_code: employee.mobile_country_code,
    mobile: employee.mobile,
    invite_method: assignmentType === "permanent"
      ? "Position Assignment"
      : profileOwner.data?.invite_method ?? "Email",
    is_active: true
  }, { onConflict: "id" });
  if (profileResult.error) throw new Error(profileResult.error.message);
  return {
    employee,
    previousInviteMethod: existingProfile.data?.invite_method ?? profileOwner.data?.invite_method ?? null,
    profileId
  };
}

export async function assignEmployeeToPosition(input: {
  actorUserId: string;
  assignmentType?: "permanent" | "acting";
  companyId: string;
  employeeId: string;
  positionId: string;
  reason?: string | null;
  validFrom?: string;
  validUntil?: string | null;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const assignmentType = input.assignmentType ?? "permanent";
  const validFrom = input.validFrom || dateOnly();
  const validUntil = input.validUntil || null;
  if (assignmentType === "acting" && !validUntil) throw new Error("Temporary cover requires an end date.");
  if (validUntil && validUntil < validFrom) throw new Error("Cover end date cannot be before the start date.");

  const positionResult = await supabaseAdmin
    .from("org_positions")
    .select("id, role_id, reports_to_position_id, location_access_mode, location_scope_ids, designation_id, is_active")
    .eq("id", input.positionId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (positionResult.error) throw new Error(positionResult.error.message);
  const position = positionResult.data;
  if (!position?.is_active) throw new Error("Selected position is not active.");

  if (assignmentType === "permanent") {
    const occupied = await supabaseAdmin
      .from("position_assignments")
      .select("id, source_employee_id")
      .eq("company_id", input.companyId)
      .eq("position_id", input.positionId)
      .eq("assignment_type", "permanent")
      .eq("is_active", true)
      .maybeSingle();
    if (occupied.error) throw new Error(occupied.error.message);
    if (occupied.data?.source_employee_id === input.employeeId) return occupied.data.id as string;
    if (occupied.data) throw new Error("This position already has a permanent occupant. End that assignment first.");
  } else {
    const existingCoverResult = await supabaseAdmin
      .from("position_assignments")
      .select("id, valid_from, valid_until")
      .eq("company_id", input.companyId)
      .eq("position_id", input.positionId)
      .eq("assignment_type", "acting")
      .eq("is_active", true);
    if (existingCoverResult.error) throw new Error(existingCoverResult.error.message);
    const overlap = (existingCoverResult.data ?? []).find((assignment) => (
      assignment.valid_from <= validUntil! && (!assignment.valid_until || assignment.valid_until >= validFrom)
    ));
    if (overlap) throw new Error("This position already has temporary cover during the selected dates.");
    const permanentOccupant = await supabaseAdmin
      .from("position_assignments")
      .select("source_employee_id")
      .eq("company_id", input.companyId)
      .eq("position_id", input.positionId)
      .eq("assignment_type", "permanent")
      .eq("is_active", true)
      .maybeSingle();
    if (permanentOccupant.error) throw new Error(permanentOccupant.error.message);
    if (permanentOccupant.data?.source_employee_id === input.employeeId) {
      throw new Error("Select another person to cover this position.");
    }
  }

  const { employee, previousInviteMethod, profileId } = await ensureEmployeeProfile(input.companyId, input.employeeId, assignmentType);
  if (position.designation_id && employee.designation_id && position.designation_id !== employee.designation_id) {
    throw new Error("The employee designation does not match this position.");
  }
  if (
    position.location_access_mode !== "all_locations" &&
    employee.location_id &&
    !(position.location_scope_ids ?? []).includes(employee.location_id)
  ) {
    throw new Error("The employee location is outside this position's scope.");
  }

  if (assignmentType === "permanent") {
    const existingPermanent = await supabaseAdmin
      .from("position_assignments")
      .select("id, position_id")
      .eq("company_id", input.companyId)
      .eq("profile_id", profileId)
      .eq("assignment_type", "permanent")
      .eq("is_active", true)
      .maybeSingle();
    if (existingPermanent.error) throw new Error(existingPermanent.error.message);
    if (existingPermanent.data) {
      throw new Error("This person already occupies another position. End that assignment first.");
    }
  }

  const profileResult = await supabaseAdmin
    .from("profiles")
    .select("role_id, reports_to_user_id, location_scope_ids")
    .eq("id", profileId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (profileResult.error) throw new Error(profileResult.error.message);

  let reportsToUserId: string | null = null;
  if (position.reports_to_position_id) {
    reportsToUserId = (await currentPositionOccupant(input.companyId, position.reports_to_position_id))?.profile_id ?? null;
  }

  const insertResult = await supabaseAdmin.from("position_assignments").insert({
    company_id: input.companyId,
    position_id: input.positionId,
    profile_id: profileId,
    source_employee_id: input.employeeId,
    assignment_type: assignmentType,
    valid_from: validFrom,
    valid_until: validUntil,
    reason: input.reason || null,
    previous_role_id: profileResult.data?.role_id ?? null,
    previous_reports_to_user_id: profileResult.data?.reports_to_user_id ?? null,
    previous_location_scope_ids: profileResult.data?.location_scope_ids ?? [],
    previous_invite_method: previousInviteMethod,
    created_by: input.actorUserId
  }).select("id").single();
  if (insertResult.error) throw new Error(insertResult.error.message);

  if (assignmentType === "permanent") {
    const updates = await Promise.all([
      supabaseAdmin.from("profiles").update({
        role_id: position.role_id,
        reports_to_user_id: reportsToUserId,
        location_scope_ids: position.location_access_mode === "all_locations" ? [] : position.location_scope_ids ?? [],
        is_active: true
      }).eq("id", profileId).eq("company_id", input.companyId),
      supabaseAdmin.from("employees").update({ org_position_id: input.positionId, updated_at: new Date().toISOString() })
        .eq("id", input.employeeId).eq("company_id", input.companyId)
    ]);
    const updateError = updates.find((result) => result.error)?.error;
    if (updateError) throw new Error(updateError.message);
  }

  await recordPositionEvent({
    actorUserId: input.actorUserId,
    assignmentId: insertResult.data.id,
    companyId: input.companyId,
    details: { assignmentType, reason: input.reason ?? null, validFrom, validUntil },
    eventType: assignmentType === "acting" ? "acting_cover_started" : "permanent_assignment_started",
    positionId: input.positionId,
    profileId
  });
  return insertResult.data.id as string;
}

export async function endPositionAssignment(input: {
  actorUserId: string;
  assignmentId: string;
  companyId: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const assignmentResult = await supabaseAdmin
    .from("position_assignments")
    .select("id, position_id, profile_id, source_employee_id, assignment_type, previous_role_id, previous_reports_to_user_id, previous_location_scope_ids, previous_invite_method, is_active")
    .eq("id", input.assignmentId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (assignmentResult.error) throw new Error(assignmentResult.error.message);
  const assignment = assignmentResult.data;
  if (!assignment?.is_active) throw new Error("This assignment is already ended.");

  const endedAt = new Date().toISOString();
  const endResult = await supabaseAdmin.from("position_assignments").update({
    is_active: false,
    ended_at: endedAt,
    ended_by: input.actorUserId,
    updated_at: endedAt
  }).eq("id", input.assignmentId).eq("company_id", input.companyId);
  if (endResult.error) throw new Error(endResult.error.message);

  if (assignment.assignment_type === "permanent") {
    const otherAssignment = await supabaseAdmin
      .from("position_assignments")
      .select("id")
      .eq("company_id", input.companyId)
      .eq("profile_id", assignment.profile_id)
      .eq("assignment_type", "permanent")
      .eq("is_active", true)
      .maybeSingle();
    if (otherAssignment.error) throw new Error(otherAssignment.error.message);
    if (!otherAssignment.data) {
      const updates = [
        supabaseAdmin.from("profiles").update({
          role_id: assignment.previous_role_id,
          reports_to_user_id: assignment.previous_reports_to_user_id,
          location_scope_ids: assignment.previous_location_scope_ids ?? [],
          invite_method: assignment.previous_invite_method
        }).eq("id", assignment.profile_id).eq("company_id", input.companyId)
      ];
      if (assignment.source_employee_id) {
        updates.push(supabaseAdmin.from("employees").update({ org_position_id: null, updated_at: endedAt })
          .eq("id", assignment.source_employee_id).eq("company_id", input.companyId));
      }
      const updateResults = await Promise.all(updates);
      const updateError = updateResults.find((result) => result.error)?.error;
      if (updateError) throw new Error(updateError.message);
    }
  }

  await recordPositionEvent({
    actorUserId: input.actorUserId,
    assignmentId: assignment.id,
    companyId: input.companyId,
    eventType: assignment.assignment_type === "acting" ? "acting_cover_ended" : "permanent_assignment_ended",
    positionId: assignment.position_id,
    profileId: assignment.profile_id
  });
}

export async function recordPositionEvent(input: {
  actorUserId: string;
  assignmentId?: string | null;
  companyId: string;
  details?: Record<string, unknown>;
  eventType: string;
  positionId?: string | null;
  profileId?: string | null;
}) {
  if (!supabaseAdmin) return;
  const result = await supabaseAdmin.from("position_access_events").insert({
    company_id: input.companyId,
    event_type: input.eventType,
    position_id: input.positionId ?? null,
    assignment_id: input.assignmentId ?? null,
    profile_id: input.profileId ?? null,
    details: input.details ?? {},
    created_by: input.actorUserId
  });
  if (result.error && !isMissingPositionAccessSchema(result.error)) throw new Error(result.error.message);
}

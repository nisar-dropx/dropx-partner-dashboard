"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { accessPages, ensureAccessPages } from "@/lib/access-pages";
import { pageBelongsToSurface, type AdminAccessSurface } from "@/lib/access-surface";
import { isCompanyOwner, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { cleanCountryCode } from "@/lib/country-codes";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("") + "Aa1!";
}

function locationScopeFromForm(formData: FormData) {
  const raw = clean(formData.get("location_scope_ids"));
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  return parsed.map((value) => String(value)).filter(Boolean);
}

function locationAccessMode(value: FormDataEntryValue | null) {
  return clean(value) === "all_locations" ? "all_locations" : "role_based";
}

function accessSurfaceFromForm(value: FormDataEntryValue | null): AdminAccessSurface {
  const surface = clean(value);
  return surface === "ops" || surface === "people" ? surface : "dashboard";
}

function appBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://dashboard.dropxlogistics.com").replace(/\/$/, "");
}

function usersRedirect(params?: Record<string, string>): never {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  redirect(`/users${query}`);
}

function safeUsersReturnHref(value: FormDataEntryValue | null) {
  const href = clean(value);
  if (!href) return "/users";

  try {
    const parsed = new URL(href, appBaseUrl());
    if (parsed.pathname !== "/users") return "/users";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return href.startsWith("/users") ? href : "/users";
  }
}

async function findAuthUserIdByEmail(email: string, companyId: string) {
  if (!supabaseAdmin) return null;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .eq("company_id", companyId)
    .maybeSingle();

  if (profile?.id) return profile.id as string;

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(error.message);

    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match?.id) return match.id;
    if (data.users.length < 100) break;
  }

  return null;
}

function isExistingUserError(message: string) {
  const text = message.toLowerCase();
  return text.includes("already") || text.includes("registered") || text.includes("exists");
}

function isLocationManagedInviteMethod(value: string | null | undefined) {
  return value === "Location Email" || value === "Location Master";
}

function isPositionManagedInviteMethod(value: string | null | undefined) {
  return value === "Position Assignment";
}

async function isLinkedLocationEmail(email: string | null | undefined, companyId: string) {
  if (!supabaseAdmin || !email) return false;

  const { count, error } = await supabaseAdmin
    .from("stations")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .ilike("station_email", email);

  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function validateReportingManager(roleId: string, reportsToUserId: string | null, companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const { data: roles, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("id, code, parent_role_id")
    .eq("company_id", companyId);
  if (rolesError) throw new Error(rolesError.message);

  const rolesById = new Map((roles ?? []).map((role) => [role.id, role.parent_role_id]));
  const roleCodesById = new Map((roles ?? []).map((role) => [role.id, role.code]));
  const selectedRoleParentId = rolesById.get(roleId);
  if (selectedRoleParentId === undefined) throw new Error("Selected role was not found.");

  if (roleCodesById.get(roleId) === "LOCATION") {
    if (!reportsToUserId) throw new Error("Reporting manager is required for a Location user.");

    const { data: manager, error: managerError } = await supabaseAdmin
      .from("profiles")
      .select("role_id, is_active")
      .eq("id", reportsToUserId)
      .eq("company_id", companyId)
      .single();

    if (managerError || !manager?.is_active) throw new Error("Reporting manager was not found or is inactive.");
    if (!manager.role_id || roleCodesById.get(manager.role_id) === "LOCATION") {
      throw new Error("Select an active manager from a non-Location role.");
    }
    return;
  }

  if (!selectedRoleParentId) {
    if (reportsToUserId) throw new Error("A top-level role cannot have a reporting manager.");
    return;
  }

  if (!reportsToUserId) throw new Error("Reporting manager is required.");

  const validManagerRoleIds = new Set<string>();
  const visited = new Set<string>();
  let currentRoleId: string | null | undefined = selectedRoleParentId;
  while (currentRoleId) {
    if (visited.has(currentRoleId)) throw new Error("The role hierarchy contains a loop.");
    visited.add(currentRoleId);
    validManagerRoleIds.add(currentRoleId);
    currentRoleId = rolesById.get(currentRoleId);
  }

  const { data: manager, error: managerError } = await supabaseAdmin
    .from("profiles")
    .select("role_id, is_active")
    .eq("id", reportsToUserId)
    .eq("company_id", companyId)
    .single();

  if (managerError || !manager?.is_active) throw new Error("Reporting manager was not found or is inactive.");
  if (!manager.role_id || !validManagerRoleIds.has(manager.role_id)) {
    throw new Error("Select a reporting manager from this role or any higher role in its hierarchy.");
  }
}

async function validateLocationScope(
  roleId: string,
  reportsToUserId: string | null,
  locationScopeIds: string[],
  companyId: string
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  const { data: selectedRole, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("location_access_mode")
    .eq("id", roleId)
    .eq("company_id", companyId)
    .single();
  if (roleError) throw new Error(roleError.message);
  if (selectedRole.location_access_mode === "all_locations") return;
  if (!locationScopeIds.length) throw new Error("Select at least one location.");
  if (!reportsToUserId) throw new Error("Reporting manager is required before selecting locations.");

  const { data: manager, error: managerError } = await supabaseAdmin
    .from("profiles")
    .select("role_id, location_scope_ids")
    .eq("id", reportsToUserId)
    .eq("company_id", companyId)
    .single();
  if (managerError) throw new Error(managerError.message);

  const { data: managerRole, error: managerRoleError } = await supabaseAdmin
    .from("user_roles")
    .select("location_access_mode")
    .eq("id", manager.role_id)
    .eq("company_id", companyId)
    .single();
  if (managerRoleError) throw new Error(managerRoleError.message);

  if (managerRole.location_access_mode === "all_locations") return;
  const allowedLocationIds = new Set<string>(manager.location_scope_ids ?? []);
  if (locationScopeIds.some((locationId) => !allowedLocationIds.has(locationId))) {
    throw new Error("One or more selected locations are outside the Reporting Manager's scope.");
  }
}

type PermissionPayload = Array<{
  page_id: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
}>;

function permissionsFromForm(formData: FormData): PermissionPayload {
  const raw = clean(formData.get("permissions_json"));
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  return parsed.map((permission) => ({
    page_id: String(permission.page_id ?? ""),
    can_view: Boolean(permission.can_view || permission.can_edit),
    can_add: Boolean(permission.can_add),
    can_edit: Boolean(permission.can_edit)
  })).filter((permission) => permission.page_id);
}

function permissionHasAccess(permission?: PermissionPayload[number] | null) {
  return Boolean(permission?.can_view || permission?.can_add || permission?.can_edit);
}

async function assertDeveloperPermissionChangeAllowed(
  companyId: string,
  authorization: AuthorizationContext,
  submittedPermissions: PermissionPayload,
  roleId?: string
) {
  if (isCompanyOwner(authorization)) return;
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured");

  let pagesResult = await supabaseAdmin
    .from("app_pages")
    .select("id")
    .eq("company_id", companyId)
    .eq("code", "developer_mode");

  if (!pagesResult.error && !(pagesResult.data ?? []).length) {
    pagesResult = await supabaseAdmin
      .from("app_pages")
      .select("id")
      .eq("code", "developer_mode");
  }

  if (pagesResult.error) throw new Error(pagesResult.error.message);
  const developerPageIds = new Set((pagesResult.data ?? []).map((page) => String(page.id)));
  if (!developerPageIds.size) return;

  const submittedByPage = new Map(submittedPermissions.map((permission) => [permission.page_id, permission]));

  if (!roleId) {
    const wantsDeveloperAccess = [...developerPageIds].some((pageId) => permissionHasAccess(submittedByPage.get(pageId)));
    if (wantsDeveloperAccess) throw new Error("Only owner can manage Developer Mode access.");
    return;
  }

  const { data: existing, error } = await supabaseAdmin
    .from("role_page_permissions")
    .select("page_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .eq("role_id", roleId)
    .in("page_id", [...developerPageIds]);
  if (error) throw new Error(error.message);

  const existingByPage = new Map((existing ?? []).map((permission) => [String(permission.page_id), permission]));
  for (const pageId of developerPageIds) {
    const before = existingByPage.get(pageId);
    const after = submittedByPage.get(pageId);
    const changed =
      Boolean(before?.can_view || before?.can_add || before?.can_edit) !== permissionHasAccess(after) ||
      Boolean(before?.can_view) !== Boolean(after?.can_view) ||
      Boolean(before?.can_add) !== Boolean(after?.can_add) ||
      Boolean(before?.can_edit) !== Boolean(after?.can_edit);
    if (changed) throw new Error("Only owner can manage Developer Mode access.");
  }
}

export async function createUserRole(formData: FormData) {
  try {
    const authorization = await requirePagePermission("users", "add");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) {
      throw new Error("Supabase service role key is not configured");
    }

    const code = required(formData.get("code"), "Role code").toUpperCase();
    const name = required(formData.get("name"), "Role name");
    const parentRoleId = required(formData.get("parent_role_id"), "Reporting role");
    const mode = locationAccessMode(required(formData.get("location_access_mode"), "Location access"));

    await ensureAccessPages(supabaseAdmin, companyId);
    const surface = accessSurfaceFromForm(formData.get("surface"));

    const { data: role, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .insert(withCompany({ code, name, parent_role_id: parentRoleId, location_access_mode: mode, is_active: true }, companyId))
      .select("id")
      .single();

    if (roleError) throw new Error(roleError.message);

    let { data: pages, error: pagesError } = await supabaseAdmin
      .from("app_pages")
      .select("id, code")
      .eq("company_id", companyId)
      .eq("is_active", true);
    if (!pagesError && !(pages ?? []).length) {
      const legacyPagesResult = await supabaseAdmin
        .from("app_pages")
        .select("id, code")
        .in("code", accessPages.map((page) => page.code))
        .eq("is_active", true);
      pages = legacyPagesResult.data;
      pagesError = legacyPagesResult.error;
    }

    if (pagesError) throw new Error(pagesError.message);

    const submittedPermissions = permissionsFromForm(formData);
    await assertDeveloperPermissionChangeAllowed(companyId, authorization, submittedPermissions);
    const submittedByPage = new Map(submittedPermissions.map((permission) => [permission.page_id, permission]));

    const permissions = (pages ?? []).filter((page) => pageBelongsToSurface(page.code, surface)).map((page) => {
      const submitted = submittedByPage.get(page.id);
      return {
        company_id: companyId,
        role_id: role.id,
        page_id: page.id,
        can_view: submitted?.can_view ?? false,
        can_add: submitted?.can_add ?? false,
        can_edit: submitted?.can_edit ?? false
      };
    });

    if (permissions.length) {
      const { error: permissionsError } = await supabaseAdmin
        .from("role_page_permissions")
        .insert(permissions);

      if (permissionsError) throw new Error(permissionsError.message);
    }

    revalidatePath("/users");
  } catch (error) {
    usersRedirect({ section: "roles", addRole: "1", userError: error instanceof Error ? error.message : "Unable to save role." });
  }

  usersRedirect({ section: "roles", userNotice: "Role saved successfully." });
}

export async function updateUserRole(formData: FormData) {
  const id = clean(formData.get("id"));

  try {
    const authorization = await requirePagePermission("users", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) {
      throw new Error("Supabase service role key is not configured");
    }

    const roleId = required(formData.get("id"), "Role ID");
    const surface = accessSurfaceFromForm(formData.get("surface"));

    const { data: existingRole, error: existingRoleError } = await supabaseAdmin
      .from("user_roles")
      .select("code, name, location_access_mode, is_active, is_system")
      .eq("id", roleId)
      .eq("company_id", companyId)
      .single();

    if (existingRoleError) throw new Error(existingRoleError.message);
    if (existingRole?.is_system || existingRole?.code === "OWNER") throw new Error("OWNER cannot be edited.");

    const isLocationRole = existingRole?.code === "LOCATION";
    const name = isLocationRole
      ? existingRole.name
      : required(formData.get("name"), "Role name");
    const mode = isLocationRole
      ? existingRole.location_access_mode
      : locationAccessMode(formData.get("location_access_mode"));
    const isActive = isLocationRole
      ? existingRole.is_active
      : formData.get("is_active") !== "inactive";
    const parentRoleId = existingRole?.code === "LOCATION"
      ? null
      : required(formData.get("parent_role_id"), "Reporting role");

    if (parentRoleId === roleId) {
      throw new Error("A role cannot report to itself.");
    }

    const { error } = await supabaseAdmin
      .from("user_roles")
      .update({
        name,
        parent_role_id: parentRoleId,
        location_access_mode: mode,
        is_active: isActive
      })
      .eq("id", roleId)
      .eq("company_id", companyId);

    if (error) throw new Error(error.message);

    const submittedPermissions = permissionsFromForm(formData);
    await assertDeveloperPermissionChangeAllowed(companyId, authorization, submittedPermissions, roleId);
    const { data: surfacePages, error: surfacePagesError } = await supabaseAdmin
      .from("app_pages")
      .select("id, code")
      .eq("company_id", companyId)
      .eq("is_active", true);
    if (surfacePagesError) throw new Error(surfacePagesError.message);

    const surfacePageIds = (surfacePages ?? [])
      .filter((page) => pageBelongsToSurface(page.code, surface))
      .map((page) => page.id);
    if (submittedPermissions.some((permission) => !surfacePageIds.includes(permission.page_id))) {
      throw new Error("The submitted permissions include pages from another frontend.");
    }

    const submittedPageIds = new Set(submittedPermissions.map((permission) => permission.page_id));
    if (surfacePageIds.some((pageId) => !submittedPageIds.has(pageId))) {
      throw new Error("The permission form is incomplete. Refresh the page and try again.");
    }

    if (submittedPermissions.length) {
      const { error: permissionsError } = await supabaseAdmin
        .from("role_page_permissions")
        .upsert(submittedPermissions.map((permission) => ({
          company_id: companyId,
          role_id: roleId,
          page_id: permission.page_id,
          can_view: permission.can_view,
          can_add: permission.can_add,
          can_edit: permission.can_edit
        })), { onConflict: "company_id,role_id,page_id" });

      if (permissionsError) throw new Error(permissionsError.message);
    }

    revalidatePath("/users");
  } catch (error) {
    usersRedirect({
      section: "roles",
      ...(id ? { editRole: id } : {}),
      userError: error instanceof Error ? error.message : "Unable to save role."
    });
  }

  usersRedirect({ section: "roles", userNotice: "Role saved successfully." });
}

async function performDeleteUserRole(formData: FormData, companyId: string) {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "Role ID");
  const replacementRoleId = clean(formData.get("replacement_role_id"));

  const [{ count: assignedUsers, error: usersError }, { count: childRoles, error: childError }, { data: role, error: roleError }, { data: roles, error: rolesError }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("role_id", id).eq("company_id", companyId),
    supabaseAdmin.from("user_roles").select("id", { count: "exact", head: true }).eq("parent_role_id", id).eq("company_id", companyId),
    supabaseAdmin.from("user_roles").select("code, is_system").eq("id", id).eq("company_id", companyId).single(),
    supabaseAdmin.from("user_roles").select("id, parent_role_id").eq("company_id", companyId)
  ]);

  if (usersError) throw new Error(usersError.message);
  if (childError) throw new Error(childError.message);
  if (roleError) throw new Error(roleError.message);
  if (rolesError) throw new Error(rolesError.message);
  if (role?.is_system) throw new Error("System roles cannot be deleted.");
  if (role?.code === "LOCATION") throw new Error("LOCATION is a built-in role and cannot be deleted.");

  const hasDependencies = (assignedUsers ?? 0) > 0 || (childRoles ?? 0) > 0;
  if (hasDependencies && !replacementRoleId) {
    throw new Error("Select a replacement role to transfer assigned users and reporting roles.");
  }

  if (replacementRoleId) {
    if (replacementRoleId === id) throw new Error("Select a different replacement role.");

    const rolesById = new Map((roles ?? []).map((item) => [item.id, item.parent_role_id]));
    if (!rolesById.has(replacementRoleId)) throw new Error("Replacement role was not found.");

    const visited = new Set<string>();
    let currentRoleId: string | null | undefined = replacementRoleId;
    while (currentRoleId) {
      if (currentRoleId === id) {
        throw new Error("A role cannot be transferred to one of its own reporting roles.");
      }
      if (visited.has(currentRoleId)) throw new Error("The role hierarchy contains a loop.");
      visited.add(currentRoleId);
      currentRoleId = rolesById.get(currentRoleId);
    }

    const { error: usersTransferError } = await supabaseAdmin
      .from("profiles")
      .update({ role_id: replacementRoleId })
      .eq("role_id", id)
      .eq("company_id", companyId);
    if (usersTransferError) throw new Error(usersTransferError.message);

    const { error: rolesTransferError } = await supabaseAdmin
      .from("user_roles")
      .update({ parent_role_id: replacementRoleId })
      .eq("parent_role_id", id)
      .eq("company_id", companyId);
    if (rolesTransferError) throw new Error(rolesTransferError.message);
  }

  const { error } = await supabaseAdmin
    .from("user_roles")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
  revalidatePath("/users");
}

export async function deleteUserRole(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    await performDeleteUserRole(formData, companyId);
  } catch (error) {
    usersRedirect({ section: "roles", userError: error instanceof Error ? error.message : "Unable to delete role." });
  }

  usersRedirect({ section: "roles", userNotice: "Role deleted successfully." });
}

export async function createUser(formData: FormData) {
  const authorization = await requirePagePermission("users", "add");
  const companyId = requireCompanyId(authorization);
  const admin = supabaseAdmin;
  if (!admin) {
    usersRedirect({ section: "users", userError: "Supabase service role key is not configured." });
  }

  let notice = "User saved successfully.";

  try {
    const employeeId = required(formData.get("employee_id"), "Employee ID").toUpperCase();
    const fullName = required(formData.get("full_name"), "Full name");
    const email = required(formData.get("email"), "Email").toLowerCase();
    const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
    const mobile = clean(formData.get("mobile"))?.replace(/\D/g, "") ?? null;
    const roleId = required(formData.get("role_id"), "Role");
    const reportsToUserId = clean(formData.get("reports_to_user_id"));
    const sendInvitation = formData.get("send_invitation") === "yes";
    const locationScopeIds = locationScopeFromForm(formData);
    if (mobile && !/^\d{6,15}$/.test(mobile)) throw new Error("Mobile number must contain 6 to 15 digits.");

    await validateReportingManager(roleId, reportsToUserId, companyId);
    await validateLocationScope(roleId, reportsToUserId, locationScopeIds, companyId);

    const { data: role, error: roleError } = await admin
      .from("user_roles")
      .select("id, name")
      .eq("id", roleId)
      .eq("company_id", companyId)
      .single();

    if (roleError) throw new Error(roleError.message);

    const authResult = sendInvitation
      ? await admin.auth.admin.inviteUserByEmail(email, {
          data: { full_name: fullName, employee_id: employeeId },
          redirectTo: `${appBaseUrl()}/login`
        })
      : await admin.auth.admin.createUser({
          email,
          password: randomPassword(),
          email_confirm: true,
          user_metadata: { full_name: fullName, employee_id: employeeId }
        });

    let userId = authResult.data.user?.id ?? null;
    if (authResult.error) {
      if (!isExistingUserError(authResult.error.message)) {
        throw new Error(authResult.error.message);
      }
      userId = await findAuthUserIdByEmail(email, companyId);
    }

    if (!userId) {
      throw new Error("This email already exists in Supabase Auth, but the user ID could not be found.");
    }

    const { error } = await admin
      .from("profiles")
      .upsert({
        id: userId,
        employee_id: employeeId,
        full_name: fullName,
        email,
        mobile_country_code: mobileCountryCode,
        mobile,
        role_id: role.id,
        reports_to_user_id: reportsToUserId,
        location_scope_ids: locationScopeIds,
        company_id: companyId,
        invite_method: sendInvitation ? "Email" : "None",
        is_active: true
      }, { onConflict: "id" });

    if (error) {
      if (error.message.toLowerCase().includes("duplicate") || error.message.toLowerCase().includes("unique")) {
        throw new Error("Employee ID or email is already used by another profile.");
      }
      throw new Error(error.message);
    }

    revalidatePath("/users");
  } catch (error) {
    usersRedirect({ section: "users", addUser: "1", userError: error instanceof Error ? error.message : "Unable to save user." });
  }

  usersRedirect({ section: "users", userNotice: notice });
}

export async function updateUser(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const returnHref = safeUsersReturnHref(formData.get("return_href"));
  const id = required(formData.get("id"), "User ID");
  const { data: existingUser, error: existingUserError } = await supabaseAdmin
    .from("profiles")
    .select("email, invite_method")
    .eq("id", id)
    .eq("company_id", companyId)
    .single();
  if (existingUserError) throw new Error(existingUserError.message);
  if (isLocationManagedInviteMethod(existingUser.invite_method) && await isLinkedLocationEmail(existingUser.email, companyId)) {
    throw new Error("This user is managed from Location Master and cannot be edited here.");
  }
  if (isPositionManagedInviteMethod(existingUser.invite_method)) {
    throw new Error("This user is managed from Positions & Delegation and cannot be edited here.");
  }

  const employeeId = required(formData.get("employee_id"), "Employee ID").toUpperCase();
  const fullName = required(formData.get("full_name"), "Full name");
  const mobileCountryCode = cleanCountryCode(formData.get("mobile_country_code"));
  const mobile = clean(formData.get("mobile"))?.replace(/\D/g, "") ?? null;
  const roleId = required(formData.get("role_id"), "Role");
  const reportsToUserId = clean(formData.get("reports_to_user_id"));
  const locationScopeIds = locationScopeFromForm(formData);
  const isActive = formData.get("is_active") !== "inactive";
  if (mobile && !/^\d{6,15}$/.test(mobile)) throw new Error("Mobile number must contain 6 to 15 digits.");

  await validateReportingManager(roleId, reportsToUserId, companyId);
  await validateLocationScope(roleId, reportsToUserId, locationScopeIds, companyId);

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      employee_id: employeeId,
      full_name: fullName,
      mobile_country_code: mobileCountryCode,
      mobile,
      role_id: roleId,
      reports_to_user_id: reportsToUserId,
      location_scope_ids: locationScopeIds,
      is_active: isActive
    })
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
  revalidatePath("/users");
  redirect(returnHref);
}

export async function resendUserInvitation(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    usersRedirect({ section: "users", userError: "Supabase service role key is not configured." });
  }

  try {
    const id = required(formData.get("id"), "User ID");

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("email, full_name, employee_id, invite_method")
      .eq("id", id)
      .eq("company_id", companyId)
      .single();

    if (profileError) throw new Error(profileError.message);
    if (isLocationManagedInviteMethod(profile.invite_method) && await isLinkedLocationEmail(profile.email, companyId)) {
      throw new Error("Location Master users do not use manual invitations.");
    }

    const email = required(profile.email, "Email").toLowerCase();
    const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: {
        full_name: profile.full_name ?? undefined,
        employee_id: profile.employee_id ?? undefined
      },
      redirectTo: `${appBaseUrl()}/login`
    });

    if (error) throw new Error(error.message);

    if (!isPositionManagedInviteMethod(profile.invite_method)) {
      await supabaseAdmin
        .from("profiles")
        .update({ invite_method: "Email" })
        .eq("id", id)
        .eq("company_id", companyId);
    }

    revalidatePath("/users");
  } catch (error) {
    usersRedirect({ section: "users", userError: error instanceof Error ? error.message : "Unable to resend invitation." });
  }

  usersRedirect({ section: "users", userNotice: "Invitation sent." });
}

async function performDeleteUser(formData: FormData, companyId: string) {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role key is not configured");
  }

  const id = required(formData.get("id"), "User ID");
  const replacementUserId = clean(formData.get("replacement_user_id"));

  const [{ data: user, error: userError }, { count: reportees, error: reporteesError }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("email, location_scope_ids, invite_method")
      .eq("id", id)
      .eq("company_id", companyId)
      .single(),
    supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("reports_to_user_id", id)
      .eq("company_id", companyId)
  ]);

  if (userError) throw new Error(userError.message);
  if (reporteesError) throw new Error(reporteesError.message);
  if (isLocationManagedInviteMethod(user.invite_method) && await isLinkedLocationEmail(user.email, companyId)) {
    throw new Error("This user is managed from Location Master and cannot be deleted here.");
  }
  if (isPositionManagedInviteMethod(user.invite_method)) {
    throw new Error("This user is managed from Positions & Delegation and cannot be deleted here.");
  }

  const { count: managedLocations, error: locationsError } = user.email
    ? await supabaseAdmin
        .from("stations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .ilike("station_manager_email", user.email)
    : { count: 0, error: null };

  if (locationsError) throw new Error(locationsError.message);

  const hasDependencies = (reportees ?? 0) > 0 || (managedLocations ?? 0) > 0;
  if (hasDependencies && !replacementUserId) {
    throw new Error("Select a replacement user to transfer reportees and managed locations.");
  }

  if (replacementUserId) {
    if (replacementUserId === id) throw new Error("Select a different replacement user.");

    const { data: replacement, error: replacementError } = await supabaseAdmin
      .from("profiles")
      .select("id, email, reports_to_user_id, location_scope_ids")
      .eq("id", replacementUserId)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .single();

    if (replacementError) throw new Error("Replacement user was not found or is inactive.");

    const profilesResult = await supabaseAdmin
      .from("profiles")
      .select("id, reports_to_user_id, location_scope_ids")
      .eq("company_id", companyId);
    if (profilesResult.error) throw new Error(profilesResult.error.message);

    const profilesById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
    const hierarchyVisited = new Set<string>();
    let reportingUserId: string | null | undefined = replacementUserId;
    while (reportingUserId) {
      if (reportingUserId === id) {
        throw new Error("A user cannot be replaced by one of their own reportees.");
      }
      if (hierarchyVisited.has(reportingUserId)) throw new Error("The reporting-manager hierarchy contains a loop.");
      hierarchyVisited.add(reportingUserId);
      reportingUserId = profilesById.get(reportingUserId)?.reports_to_user_id;
    }

    const { error: reporteesTransferError } = await supabaseAdmin
      .from("profiles")
      .update({ reports_to_user_id: replacementUserId })
      .eq("reports_to_user_id", id)
      .eq("company_id", companyId);
    if (reporteesTransferError) throw new Error(reporteesTransferError.message);

    if (user.email && replacement.email) {
      const { error: locationsTransferError } = await supabaseAdmin
        .from("stations")
        .update({ station_manager_email: replacement.email })
        .eq("company_id", companyId)
        .ilike("station_manager_email", user.email);
      if (locationsTransferError) throw new Error(locationsTransferError.message);
    }

    const transferredScope = new Set<string>(user.location_scope_ids ?? []);
    const visited = new Set<string>();
    let currentUserId: string | null | undefined = replacementUserId;

    while (currentUserId) {
      if (visited.has(currentUserId)) throw new Error("The reporting-manager hierarchy contains a loop.");
      visited.add(currentUserId);

      const profile = profilesById.get(currentUserId);
      if (!profile) break;
      const nextScope = Array.from(new Set([...(profile.location_scope_ids ?? []), ...transferredScope]));
      const { error: scopeError } = await supabaseAdmin
        .from("profiles")
        .update({ location_scope_ids: nextScope })
        .eq("id", currentUserId)
        .eq("company_id", companyId);
      if (scopeError) throw new Error(scopeError.message);

      currentUserId = profile.reports_to_user_id;
    }
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .delete()
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) throw new Error(error.message);
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (authError && !authError.message.toLowerCase().includes("not found")) {
    throw new Error(authError.message);
  }
  revalidatePath("/users");
  revalidatePath("/master/location");
}

export async function deleteUser(formData: FormData) {
  const authorization = await requirePagePermission("users", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    await performDeleteUser(formData, companyId);
  } catch (error) {
    usersRedirect({ section: "users", userError: error instanceof Error ? error.message : "Unable to delete user." });
  }

  usersRedirect({ section: "users", userNotice: "User deleted successfully." });
}

import { AppShell } from "@/components/app-shell";
import { AddUserForm } from "@/components/add-user-form";
import { DismissibleModal, DismissModalButton } from "@/components/dismissible-modal";
import { ManageUserForm } from "@/components/manage-user-form";
import { PageHead } from "@/components/page-head";
import { PermissionMatrix } from "@/components/permission-matrix";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { UserRolesListPanel } from "@/components/user-roles-list-panel";
import { UsersListPanel } from "@/components/users-list-panel";
import { accessSurfaceLabel, currentAdminAccessSurface, pageBelongsToSurface } from "@/lib/access-surface";
import { accessPages, ensureAccessPages } from "@/lib/access-pages";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createUserRole, deleteUser, deleteUserRole, updateUserRole } from "./actions";

type AppPageRow = {
  id: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
};

type UserRoleRow = {
  id: string;
  code: string;
  name: string;
  location_access_mode: "all_locations" | "role_based";
  parent_role_id: string | null;
  is_system: boolean;
  is_active: boolean;
};

type RolePermissionRow = {
  role_id: string;
  page_id: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
};

type UserRow = {
  id: string;
  employee_id: string | null;
  full_name: string | null;
  email: string | null;
  mobile_country_code?: string | null;
  mobile: string | null;
  role_id: string | null;
  role: string;
  reports_to_user_id: string | null;
  location_scope_ids: string[] | null;
  invite_method: string | null;
  is_active: boolean;
  confirmed_at?: string | null;
  email_confirmed_at?: string | null;
  invited_at?: string | null;
  last_sign_in_at?: string | null;
  identity_verified?: boolean;
};

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  city: string | null;
  state: string | null;
  station_email: string | null;
  station_manager_email: string | null;
  hide_from_location_list?: boolean | null;
  is_active: boolean;
  providers?: { name: string } | null;
  location_models?: { code: string; name: string } | null;
};

type RawLocationRow = Omit<LocationRow, "providers" | "location_models"> & {
  providers?: { name: string } | { name: string }[] | null;
  location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
};

type UsersPageProps = {
  searchParams?: {
    addUser?: string;
    addRole?: string;
    editUser?: string;
    editRole?: string;
    userPage?: string;
    userRole?: string;
    userSearch?: string;
    userType?: string;
    userError?: string;
    userNotice?: string;
    section?: string;
  };
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isMissingCompanyColumn(error: unknown) {
  if (!error) return false;
  const message =
    typeof error === "object" && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("company_id") &&
    (normalized.includes("does not exist") || normalized.includes("schema cache"))
  );
}

function isMissingColumnError(error: unknown) {
  if (!error) return false;
  const message =
    typeof error === "object" && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : String(error);
  const normalized = message.toLowerCase();

  return normalized.includes("column") &&
    (normalized.includes("does not exist") || normalized.includes("schema cache"));
}

function permissionText(role: UserRoleRow, permissions: RolePermissionRow[], pages: AppPageRow[]) {
  const surfacePageIds = new Set(pages.map((page) => page.id));
  const rolePermissions = permissions.filter(
    (permission) => permission.role_id === role.id && surfacePageIds.has(permission.page_id)
  );
  const viewCount = rolePermissions.filter((permission) => permission.can_view).length;
  const addCount = rolePermissions.filter((permission) => permission.can_add).length;
  const editCount = rolePermissions.filter((permission) => permission.can_edit).length;

  return `${viewCount} view / ${addCount} add / ${editCount} edit`;
}

function descendantRoleIds(roles: UserRoleRow[], rootId: string) {
  const descendants = new Set<string>();
  let added = true;

  while (added) {
    added = false;
    roles.forEach((role) => {
      if (role.parent_role_id === rootId || (role.parent_role_id && descendants.has(role.parent_role_id))) {
        if (!descendants.has(role.id)) {
          descendants.add(role.id);
          added = true;
        }
      }
    });
  }

  return descendants;
}

function descendantUserIds(users: UserRow[], rootId: string) {
  const descendants = new Set<string>();
  let added = true;

  while (added) {
    added = false;
    users.forEach((user) => {
      if (user.reports_to_user_id === rootId || (user.reports_to_user_id && descendants.has(user.reports_to_user_id))) {
        if (!descendants.has(user.id)) {
          descendants.add(user.id);
          added = true;
        }
      }
    });
  }

  return descendants;
}

function userStatus(user: UserRow) {
  if (!user.is_active) return "Inactive";
  const hasAcceptedInvite = Boolean(
    user.confirmed_at ||
    user.email_confirmed_at ||
    user.last_sign_in_at ||
    user.identity_verified
  );
  if (user.invited_at && !hasAcceptedInvite) return "Invitation Pending";
  return "Active";
}

function usersReturnHref(searchParams: UsersPageProps["searchParams"]) {
  const params = new URLSearchParams();
  params.set("section", "users");
  const page = Number(searchParams?.userPage ?? "1");
  if (Number.isFinite(page) && page > 1) {
    params.set("userPage", String(Math.floor(page)));
  }
  if (searchParams?.userRole) params.set("userRole", searchParams.userRole);
  if (searchParams?.userSearch) params.set("userSearch", searchParams.userSearch);
  if (searchParams?.userType) params.set("userType", searchParams.userType);

  const query = params.toString();
  return `/users${query ? `?${query}` : ""}`;
}

function sectionHref(section: "roles" | "users", params?: Record<string, string>) {
  const search = new URLSearchParams({ section });
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  return `/users?${search.toString()}`;
}

async function loadAccessData(
  companyId: string,
  surface: ReturnType<typeof currentAdminAccessSurface>,
  options: { includeUsers: boolean; includeRoleEditorData: boolean }
) {
  if (!supabaseAdmin) {
    return {
      pages: accessPages
        .filter((page) => pageBelongsToSurface(page.code, surface))
        .map((page) => ({ ...page, id: page.code, is_active: true })) as AppPageRow[],
      roles: [] as UserRoleRow[],
      permissions: [] as RolePermissionRow[],
      users: [] as UserRow[],
      locations: [] as LocationRow[],
      error: "Supabase service role key is not configured."
    };
  }

  await ensureAccessPages(supabaseAdmin, companyId);
  const client = supabaseAdmin;

  const pagesPromise = (async () => {
    let result = await client
      .from("app_pages")
      .select("id, code, name, sort_order, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("sort_order");
    if (isMissingCompanyColumn(result.error)) {
      result = await client
        .from("app_pages")
        .select("id, code, name, sort_order, is_active")
        .eq("is_active", true)
        .order("sort_order");
    }
    if (!result.error && !(result.data ?? []).length) {
      result = await client
        .from("app_pages")
        .select("id, code, name, sort_order, is_active")
        .in("code", accessPages.map((page) => page.code))
        .is("company_id", null)
        .eq("is_active", true)
        .order("sort_order");
    }
    return result;
  })();

  const rolesPromise = (async () => {
    let result = await client
      .from("user_roles")
      .select("id, code, name, location_access_mode, parent_role_id, is_system, is_active")
      .eq("company_id", companyId)
      .order("code");
    if (isMissingCompanyColumn(result.error)) {
      result = await client
        .from("user_roles")
        .select("id, code, name, location_access_mode, parent_role_id, is_system, is_active")
        .order("code");
    }
    if (!result.error && !(result.data ?? []).length) {
      result = await client
        .from("user_roles")
        .select("id, code, name, location_access_mode, parent_role_id, is_system, is_active")
        .eq("is_active", true)
        .order("code");
    }
    return result;
  })();

  const permissionsPromise = (async () => {
    const pageSize = 1000;
    async function loadPermissionPages(filterByCompany: boolean) {
      const data: RolePermissionRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        let query = client
          .from("role_page_permissions")
          .select("role_id, page_id, can_view, can_add, can_edit")
          .order("role_id")
          .order("page_id")
          .range(offset, offset + pageSize - 1);
        if (filterByCompany) query = query.eq("company_id", companyId);
        const result = await query;
        if (result.error) return { data: null, error: result.error };
        const rows = (result.data ?? []) as RolePermissionRow[];
        data.push(...rows);
        if (rows.length < pageSize) return { data, error: null };
      }
    }

    let result = await loadPermissionPages(true);
    if (isMissingCompanyColumn(result.error)) {
      result = await loadPermissionPages(false);
    }
    return result;
  })();

  const usersPromise = (async (): Promise<{ data: UserRow[] | null; error: { message?: string } | null }> => {
    if (!options.includeUsers) return { data: [], error: null };
    let result = await client
      .from("profiles")
      .select("id, employee_id, full_name, email, mobile_country_code, mobile, role_id, role, reports_to_user_id, location_scope_ids, invite_method, is_active")
      .eq("company_id", companyId)
      .order("full_name") as unknown as { data: UserRow[] | null; error: { message?: string } | null };
    if (isMissingColumnError(result.error)) {
      result = await client
        .from("profiles")
        .select("id, employee_id, full_name, email, mobile, role_id, role, reports_to_user_id, location_scope_ids, invite_method, is_active")
        .eq("company_id", companyId)
        .order("full_name") as unknown as { data: UserRow[] | null; error: { message?: string } | null };
    }
    if (isMissingCompanyColumn(result.error)) {
      result = await client
        .from("profiles")
        .select("id, employee_id, full_name, email, mobile, role_id, role, reports_to_user_id, location_scope_ids, invite_method, is_active")
        .order("full_name") as unknown as { data: UserRow[] | null; error: { message?: string } | null };
    }
    return result;
  })();

  const locationsPromise = (async (): Promise<{ data: RawLocationRow[] | null; error: { message?: string } | null }> => {
    if (!options.includeUsers && !options.includeRoleEditorData) return { data: [], error: null };
    const locationSelect = `
        id,
        station_code,
        station_name,
        city,
        state,
        station_email,
        station_manager_email,
        hide_from_location_list,
        is_active,
        providers (name),
        location_models (code, name)
      `;
    const legacyLocationSelect = `
        id,
        station_code,
        station_name,
        city,
        state,
        station_email,
        station_manager_email,
        is_active,
        providers (name),
        location_models (code, name)
      `;
    let result = await client
      .from("stations")
      .select(locationSelect)
      .eq("is_active", true)
      .eq("company_id", companyId)
      .order("station_code") as unknown as { data: RawLocationRow[] | null; error: { message?: string } | null };
    if (isMissingColumnError(result.error)) {
      result = await client
        .from("stations")
        .select(legacyLocationSelect)
        .eq("is_active", true)
        .eq("company_id", companyId)
        .order("station_code") as unknown as { data: RawLocationRow[] | null; error: { message?: string } | null };
    }
    if (isMissingCompanyColumn(result.error)) {
      result = await client
        .from("stations")
        .select(legacyLocationSelect)
        .eq("is_active", true)
        .order("station_code") as unknown as { data: RawLocationRow[] | null; error: { message?: string } | null };
    }
    return result;
  })();

  const [pagesResult, rolesResult, permissionsResult, usersResult, locationsResult] = await Promise.all([
    pagesPromise,
    rolesPromise,
    permissionsPromise,
    usersPromise,
    locationsPromise
  ]);

  const rawLocations = (locationsResult.data ?? []) as unknown as RawLocationRow[];
  const users = (usersResult.data ?? []) as UserRow[];

  return {
    pages: ((pagesResult.data ?? []) as AppPageRow[])
      .filter((page) => page.code !== "company_master" && pageBelongsToSurface(page.code, surface)),
    roles: (rolesResult.data ?? []) as UserRoleRow[],
    permissions: ((permissionsResult.data ?? []) as RolePermissionRow[])
      .filter((permission) => ((rolesResult.data ?? []) as UserRoleRow[]).some((role) => role.id === permission.role_id)),
    users,
    locations: rawLocations.map((location) => ({
      ...location,
      hide_from_location_list: Boolean(location.hide_from_location_list),
      providers: firstRelation(location.providers),
      location_models: firstRelation(location.location_models)
    })) as LocationRow[],
    error: pagesResult.error?.message || rolesResult.error?.message || permissionsResult.error?.message || usersResult.error?.message || locationsResult.error?.message || null
  };
}

export const dynamic = "force-dynamic";

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const authorization = await requirePagePermission("users", "access");
  const companyId = requireCompanyId(authorization);
  const accessSurface = currentAdminAccessSurface();
  const pagePermission = authorization.permissions.users;
  const activeSection = searchParams?.section === "roles" || searchParams?.addRole || searchParams?.editRole ? "roles" : "users";
  const showUsersSection = activeSection === "users";
  const showRolesSection = activeSection === "roles";
  const needsUserData = showUsersSection || Boolean(searchParams?.addUser || searchParams?.editUser);
  const needsRoleEditorData = Boolean(searchParams?.addRole || searchParams?.editRole);
  const { pages, roles, permissions, users, locations, error } = await loadAccessData(companyId, accessSurface, {
    includeUsers: needsUserData,
    includeRoleEditorData: needsRoleEditorData
  });
  const showAddUser = pagePermission.canAdd && searchParams?.addUser === "1";
  const showAddRole = pagePermission.canAdd && searchParams?.addRole === "1";
  const editUser = pagePermission.canEdit ? users.find((user) => user.id === searchParams?.editUser) ?? null : null;
  const editRole = pagePermission.canEdit ? roles.find((role) => role.id === searchParams?.editRole) ?? null : null;
  const roleModalError = showAddRole || editRole ? searchParams?.userError ?? null : null;
  const pageUserError = roleModalError ? null : searchParams?.userError ?? null;
  const userReturnHref = usersReturnHref(searchParams);
  const visibleLocations = authorization.hasAllLocationAccess
    ? locations
    : locations.filter((location) => authorization.locationScopeIds.includes(location.id) && !location.hide_from_location_list);
  const locationScopeOptions = visibleLocations.map((location) => ({
    id: location.id,
    code: location.station_code,
    name: location.station_name || location.station_code,
    city: location.city,
    state: location.state,
    provider: location.providers?.name ?? null,
    model: location.location_models?.name || location.location_models?.code || null
  }));
  const addUserRoles = roles.map((role) => ({
    id: role.id,
    code: role.code,
    locationAccessMode: role.location_access_mode,
    name: role.name,
    parentRoleId: role.parent_role_id
  }));
  const addUserProfiles = users.map((user) => ({
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    isActive: user.is_active,
    roleId: user.role_id,
    locationScopeIds: user.location_scope_ids ?? []
  }));
  const reportingRoleOptions = roles.map((role) => ({
    value: role.id,
    label: role.name,
    helper: role.code
  }));
  const editRoleReportingOptions = roles.filter((role) => role.id !== editRole?.id).map((role) => ({
    value: role.id,
    label: role.name,
    helper: role.code
  }));
  const editRolePermissions = editRole
    ? permissions.filter((permission) => permission.role_id === editRole.id)
    : [];
  const assignedRoleUsers = editRole ? users.filter((user) => user.role_id === editRole.id).length : 0;
  const childRoles = editRole ? roles.filter((role) => role.parent_role_id === editRole.id).length : 0;
  const roleHasDependencies = assignedRoleUsers + childRoles > 0;
  const excludedReplacementRoles = editRole ? descendantRoleIds(roles, editRole.id) : new Set<string>();
  if (editRole) excludedReplacementRoles.add(editRole.id);
  const replacementRoleOptions = roles
    .filter((role) => role.is_active && !excludedReplacementRoles.has(role.id))
    .map((role) => ({ value: role.id, label: role.name, helper: role.code }));
  const directReportees = editUser ? users.filter((user) => user.reports_to_user_id === editUser.id).length : 0;
  const linkedLocationEmailCount = editUser?.email
    ? locations.filter((location) => location.station_email?.toLowerCase() === editUser.email?.toLowerCase()).length
    : 0;
  const editUserIsLocationManaged = ["Location Email", "Location Master"].includes(editUser?.invite_method ?? "") && linkedLocationEmailCount > 0;
  const managedLocations = editUser?.email
    ? locations.filter((location) => location.station_manager_email?.toLowerCase() === editUser.email?.toLowerCase()).length
    : 0;
  const userHasDependencies = directReportees + managedLocations > 0;
  const excludedReplacementUsers = editUser ? descendantUserIds(users, editUser.id) : new Set<string>();
  if (editUser) excludedReplacementUsers.add(editUser.id);
  const replacementUserOptions = users
    .filter((user) => user.is_active && !excludedReplacementUsers.has(user.id))
    .map((user) => ({
      value: user.id,
      label: user.full_name || user.email || "Unnamed user",
      helper: user.employee_id || user.email || undefined
    }));

  return (
    <AppShell active="Users & Access">
      <PageHead
        eyebrow={`${accessSurfaceLabel(accessSurface)} admin setup`}
        title={showRolesSection ? "User roles and permissions" : "Users and station access"}
        subtitle={showRolesSection
          ? `Define role hierarchy and permissions for the ${accessSurfaceLabel(accessSurface).toLowerCase()} frontend only. Other frontend permissions are preserved.`
          : `Create users and manage access for the ${accessSurfaceLabel(accessSurface).toLowerCase()} frontend.`}
      />

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <strong>Role database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/user_roles_company_scope_repair_v1.sql` in Supabase SQL editor, then refresh this page.
            </p>
          </div>
        </section>
      ) : null}

      {pageUserError || searchParams?.userNotice ? (
        <section className={`panel message-panel ${pageUserError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{pageUserError ? "Action failed" : "Action completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {pageUserError ?? searchParams?.userNotice}
            </p>
          </div>
        </section>
      ) : null}

      {showUsersSection && (pagePermission.canView || pagePermission.canEdit) ? (
      <UsersListPanel
        canAdd={pagePermission.canAdd}
        canEdit={pagePermission.canEdit}
        initialPage={Number(searchParams?.userPage ?? "1")}
        initialQuery={searchParams?.userSearch ?? ""}
        initialRoleId={searchParams?.userRole ?? "all"}
        initialUserType={searchParams?.userType ?? "user"}
        locations={visibleLocations.map((location) => ({
          id: location.id,
          code: location.station_code,
          name: location.station_name || location.station_code,
          city: location.city,
          email: location.station_email,
          model: location.location_models?.name || location.location_models?.code || null,
          provider: location.providers?.name ?? null,
          station_manager_email: location.station_manager_email,
          state: location.state
        }))}
        roles={roles.map((role) => ({
          id: role.id,
          code: role.code,
          locationAccessMode: role.location_access_mode,
          name: role.name,
          parentRoleId: role.parent_role_id
        }))}
        users={users}
      />
      ) : null}

      {showRolesSection && (pagePermission.canView || pagePermission.canEdit) ? (
      <UserRolesListPanel
        canAdd={pagePermission.canAdd}
        canEdit={pagePermission.canEdit}
        roles={roles.map((role) => ({
          ...role,
          permissionSummary: permissionText(role, permissions, pages)
        }))}
      />
      ) : null}

      {showAddUser ? (
        <DismissibleModal closeHref={sectionHref("users")}>
          <section className="modal-panel wide" aria-label="Add user">
            <div className="panel-head">
              <div>
                <h2>Add user</h2>
                <p className="subtle">Create the login user, assign a role, and set location access.</p>
              </div>
              <DismissModalButton className="icon-button" aria-label="Close add user">x</DismissModalButton>
            </div>
            <div className="panel-body">
              <AddUserForm roles={addUserRoles} users={addUserProfiles} locations={locationScopeOptions} />
            </div>
          </section>
        </DismissibleModal>
      ) : null}

      {showAddRole ? (
        <DismissibleModal closeHref={sectionHref("roles")}>
          <section className="modal-panel wide" aria-label="Add user role">
            <div className="panel-head">
              <div>
                <h2>Add user role</h2>
                <p className="subtle">Set the role code, role name, and page-level permissions.</p>
              </div>
              <DismissModalButton className="icon-button" aria-label="Close add user role">x</DismissModalButton>
            </div>
            {roleModalError ? (
              <div className="modal-inline-message error" role="alert">
                <strong>Role not saved</strong>
                <span>{roleModalError}</span>
              </div>
            ) : null}
            <form action={createUserRole}>
              <input name="surface" type="hidden" value={accessSurface} />
              <div className="form-grid">
                <label>Role code<input className="field" name="code" placeholder="Enter role code" required /></label>
                <label>Role name<input className="field" name="name" placeholder="Enter role name" required /></label>
                <label>Reporting role
                  <SearchableSelect name="parent_role_id" options={reportingRoleOptions} placeholder="Search reporting role" required />
                </label>
                <label>Location access
                  <select className="select" name="location_access_mode" defaultValue="" required>
                    <option value="" disabled>Select location access</option>
                    <option value="role_based">Role based location access</option>
                    <option value="all_locations">All location access</option>
                  </select>
                </label>
              </div>
              <PermissionMatrix pages={pages} surface={accessSurface} />
              {error ? (
                <p className="form-note">
                  Save is locked until the user-role database tables are created in Supabase.
                </p>
              ) : null}
              <div className="form-actions modal-actions">
                <SubmitButton disabled={Boolean(error)} disabledText="DB setup needed">Save role</SubmitButton>
                <DismissModalButton className="button secondary">Cancel</DismissModalButton>
              </div>
            </form>
          </section>
        </DismissibleModal>
      ) : null}

      {editRole ? (
        <DismissibleModal closeHref={sectionHref("roles")}>
          <section className="modal-panel wide" aria-label="Manage user role">
            <div className="panel-head">
              <div>
                <h2>Manage user role</h2>
                <p className="subtle">Edit role hierarchy, location access, permissions, and active status.</p>
              </div>
              <DismissModalButton className="icon-button" aria-label="Close manage user role">x</DismissModalButton>
            </div>
            {roleModalError ? (
              <div className="modal-inline-message error" role="alert">
                <strong>Role not saved</strong>
                <span>{roleModalError}</span>
              </div>
            ) : null}
            {editRole.code === "OWNER" ? (
              <div className="panel-body">
                <strong>System role locked</strong>
                <p className="subtle" style={{ marginTop: 6 }}>
                  OWNER is protected and cannot be edited or deleted.
                </p>
                <div className="form-actions" style={{ marginTop: 14 }}>
                  <DismissModalButton className="button secondary">Close</DismissModalButton>
                </div>
              </div>
            ) : (
              <>
                <form action={updateUserRole}>
                  <input type="hidden" name="id" value={editRole.id} />
                  <input name="surface" type="hidden" value={accessSurface} />
                  <div className="form-grid">
                    <label>Role code<input className="field" defaultValue={editRole.code} disabled /></label>
                    <label>Role name<input className="field" name="name" defaultValue={editRole.name} disabled={editRole.code === "LOCATION"} required /></label>
                    {editRole.code === "LOCATION" ? (
                      <label>Reporting role<input className="field" value="No reporting role" disabled /></label>
                    ) : (
                      <label>Reporting role
                        <SearchableSelect name="parent_role_id" options={editRoleReportingOptions} defaultValue={editRole.parent_role_id ?? editRoleReportingOptions[0]?.value ?? ""} placeholder="Search reporting role" required />
                      </label>
                    )}
                    <label>Location access
                      <select className="select" name="location_access_mode" defaultValue={editRole.location_access_mode} disabled={editRole.code === "LOCATION"}>
                        <option value="role_based">Role based location access</option>
                        <option value="all_locations">All location access</option>
                      </select>
                    </label>
                    <label>Status
                      <select className="select" name="is_active" defaultValue={editRole.is_active ? "active" : "inactive"} disabled={editRole.code === "LOCATION"}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </label>
                  </div>
                  <PermissionMatrix
                    key={`${accessSurface}:${editRole.id}:${editRolePermissions.map((permission) => `${permission.page_id}:${Number(permission.can_view)}${Number(permission.can_add)}${Number(permission.can_edit)}`).sort().join("|")}`}
                    pages={pages}
                    initialPermissions={editRolePermissions}
                    surface={accessSurface}
                  />
                  <div className="form-actions modal-actions">
                    <SubmitButton>Save role</SubmitButton>
                    <DismissModalButton className="button secondary">Cancel</DismissModalButton>
                  </div>
                </form>
                {editRole.code !== "LOCATION" ? (
                  <form action={deleteUserRole} className="danger-form">
                    <input type="hidden" name="id" value={editRole.id} />
                    <SubmitButton
                      className="button warning"
                      confirmMessage={roleHasDependencies
                        ? "Delete this role and transfer all existing data to the selected replacement role?"
                        : "Delete this role? This action cannot be undone."}
                      confirmationSelect={roleHasDependencies ? {
                        name: "replacement_role_id",
                        label: "Transfer existing data to",
                        options: replacementRoleOptions,
                        placeholder: "Select replacement role",
                        helper: `${assignedRoleUsers} assigned users, ${childRoles} reporting roles`
                      } : undefined}
                      pendingText="Deleting"
                    >Delete role</SubmitButton>
                  </form>
                ) : null}
              </>
            )}
          </section>
        </DismissibleModal>
      ) : null}

      {editUser ? (
        <DismissibleModal closeHref={userReturnHref}>
          <section className="modal-panel" aria-label="Manage user">
            <div className="panel-head">
              <div>
                <h2>Manage user</h2>
                <p className="subtle">Update the user role or deactivate/delete the profile.</p>
              </div>
              <DismissModalButton className="icon-button" aria-label="Close manage user">x</DismissModalButton>
            </div>
            <ManageUserForm
              locations={locationScopeOptions}
              returnHref={userReturnHref}
              roles={addUserRoles}
              user={{
                id: editUser.id,
                employeeId: editUser.employee_id,
                fullName: editUser.full_name,
                email: editUser.email,
                mobileCountryCode: editUser.mobile_country_code ?? "91",
                mobile: editUser.mobile,
                roleId: editUser.role_id,
                reportsToUserId: editUser.reports_to_user_id,
                locationScopeIds: editUser.location_scope_ids ?? [],
                isActive: editUser.is_active,
                invitationPending: userStatus(editUser) === "Invitation Pending",
                isLocationManaged: editUserIsLocationManaged
              }}
              users={addUserProfiles}
            />
            {!editUserIsLocationManaged ? <form action={deleteUser} className="danger-form">
              <input type="hidden" name="id" value={editUser.id} />
              <SubmitButton
                className="button warning"
                confirmMessage={userHasDependencies
                  ? "Delete this user and transfer all existing data to the selected replacement user?"
                  : "Delete this user? This action cannot be undone."}
                confirmationSelect={userHasDependencies ? {
                  name: "replacement_user_id",
                  label: "Transfer existing data to",
                  options: replacementUserOptions,
                  placeholder: "Select replacement user",
                  helper: `${directReportees} reportees, ${managedLocations} managed locations`
                } : undefined}
                pendingText="Deleting"
              >Delete user</SubmitButton>
            </form> : null}
          </section>
        </DismissibleModal>
      ) : null}
    </AppShell>
  );
}

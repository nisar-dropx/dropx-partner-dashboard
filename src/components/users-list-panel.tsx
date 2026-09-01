"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { MouseEvent, PointerEvent, useEffect, useMemo, useState } from "react";
import { PendingLink } from "@/components/pending-link";
import { SearchableSelect } from "@/components/searchable-select";
import { StatusPill } from "@/components/status-pill";

export type UsersListRole = {
  id: string;
  code: string;
  locationAccessMode: "all_locations" | "role_based";
  name: string;
  parentRoleId: string | null;
};

export type UsersListLocation = {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  email: string | null;
  model?: string | null;
  provider?: string | null;
  station_manager_email?: string | null;
  state?: string | null;
};

export type UsersListUser = {
  id: string;
  employee_id: string | null;
  full_name: string | null;
  email: string | null;
  mobile: string | null;
  role_id: string | null;
  role: string | null;
  reports_to_user_id: string | null;
  location_scope_ids: string[] | null;
  invite_method: string | null;
  is_active: boolean;
  confirmed_at?: string | null;
  email_confirmed_at?: string | null;
  invited_at?: string | null;
  last_sign_in_at?: string | null;
  identity_verified?: boolean;
  access_label?: string | null;
  access_code?: string | null;
  access_source?: "people" | "location" | "manual";
  portal_codes?: string[];
  people_profile_url?: string | null;
  has_all_location_access?: boolean;
};

const PAGE_SIZE = 10;
const USER_TYPE_OPTIONS = new Set(["all", "user", "location"]);

function userStatus(user: UsersListUser) {
  if (!user.is_active) return "Inactive";
  if (user.identity_verified || user.email_confirmed_at || user.confirmed_at || user.last_sign_in_at) return "Active";
  if (user.invited_at) return "Invitation Pending";
  return "Active";
}

export function UsersListPanel({
  canAdd,
  canEdit,
  initialPage,
  initialQuery,
  initialRoleId,
  initialUserType,
  locations,
  roles,
  users
}: {
  canAdd: boolean;
  canEdit: boolean;
  initialPage?: number;
  initialQuery?: string;
  initialRoleId?: string;
  initialUserType?: string;
  locations: UsersListLocation[];
  roles: UsersListRole[];
  users: UsersListUser[];
}) {
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const pathname = usePathname();
  const [query, setQuery] = useState(() => initialQuery ?? searchParams.get("userSearch") ?? "");
  const [page, setPage] = useState(() => {
    const pageParam = Number(initialPage ?? searchParams.get("userPage") ?? "1");
    return Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
  });
  const [roleId, setRoleId] = useState(() => initialRoleId ?? searchParams.get("userRole") ?? "all");
  const [userType, setUserType] = useState(() => {
    const param = initialUserType ?? searchParams.get("userType") ?? "user";
    return USER_TYPE_OPTIONS.has(param) ? param : "user";
  });
  const roleOptions = useMemo(() => [...new Map(users.map((user) => {
    const key = user.access_code ? `access:${user.access_code}` : user.role_id ?? "unassigned";
    const label = user.access_label || roles.find((role) => role.id === user.role_id)?.name || user.role || "Unassigned";
    return [key, { value: key, label }];
  })).values()].sort((left, right) => left.label.localeCompare(right.label)), [roles, users]);
  const locationsById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const locationEmails = useMemo(
    () => new Set(locations.map((location) => location.email?.trim().toLowerCase()).filter(Boolean) as string[]),
    [locations]
  );

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();

    return users.filter((user) => {
      const roleName = user.access_label || roles.find((role) => role.id === user.role_id)?.name || user.role || "";
      const accessKey = user.access_code ? `access:${user.access_code}` : user.role_id ?? "unassigned";
      const isLocationUser = user.access_source === "location" || (
        ["Location Email", "Location Master"].includes(user.invite_method ?? "")
        && Boolean(user.email && locationEmails.has(user.email.trim().toLowerCase()))
      );
      const matchesSearch = !term || [
        user.full_name,
        user.employee_id,
        user.email,
        roleName
      ].some((value) => (value ?? "").toLowerCase().includes(term));
      const matchesRole = roleId === "all" || accessKey === roleId || user.role_id === roleId;
      const matchesType = userType === "all" || (userType === "location" ? isLocationUser : !isLocationUser);

      return matchesSearch && matchesRole && matchesType;
    });
  }, [locationEmails, query, roleId, roles, userType, users]);
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    const pageParam = Number(searchParams.get("userPage") ?? "1");
    const nextPage = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
    const nextType = searchParams.get("userType") ?? "user";
    setPage(nextPage);
    setQuery(searchParams.get("userSearch") ?? "");
    setRoleId(searchParams.get("userRole") ?? "all");
    setUserType(USER_TYPE_OPTIONS.has(nextType) ? nextType : "user");
  }, [searchKey, searchParams]);

  function locationScopeTags(user: UsersListUser) {
    if (user.has_all_location_access) return [{ label: "All locations", muted: false }];
    const ids = user.location_scope_ids ?? [];
    if (!ids.length) return null;
    const labels = ids.map((id) => locationsById.get(id)?.code).filter(Boolean);
    if (!labels.length) return [{ label: `${ids.length} selected`, muted: true }];
    const visibleLabels = labels.slice(0, 3).map((label) => ({ label, muted: false }));
    if (labels.length <= 3) return visibleLabels;
    return [...visibleLabels, { label: `+${labels.length - 3}`, muted: true }];
  }

  function resetPage() {
    updateListParams({ page: 1 });
  }

  function updatePage(nextPage: number) {
    updateListParams({ page: nextPage });
  }

  function updateListParams({
    nextQuery = query,
    nextRoleId = roleId,
    nextUserType = userType,
    page: nextPage
  }: {
    nextQuery?: string;
    nextRoleId?: string;
    nextUserType?: string;
    page: number;
  }) {
    const safePage = Math.max(1, Math.min(totalPages, nextPage));
    setPage(safePage);
    setQuery(nextQuery);
    setRoleId(nextRoleId || "all");
    setUserType(USER_TYPE_OPTIONS.has(nextUserType) ? nextUserType : "user");

    const params = new URLSearchParams(searchParams.toString());
    params.delete("editUser");
    params.delete("userNotice");
    params.delete("userError");

    if (nextQuery.trim()) {
      params.set("userSearch", nextQuery.trim());
    } else {
      params.delete("userSearch");
    }

    if (nextRoleId && nextRoleId !== "all") {
      params.set("userRole", nextRoleId);
    } else {
      params.delete("userRole");
    }

    if (nextUserType && nextUserType !== "user") {
      params.set("userType", nextUserType);
    } else {
      params.delete("userType");
    }

    if (safePage <= 1) {
      params.delete("userPage");
    } else {
      params.set("userPage", String(safePage));
    }

    const queryString = params.toString();
    const nextUrl = `${pathname}${queryString ? `?${queryString}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }

  function editUserUrl(userId: string) {
    const params = new URLSearchParams();
    params.set("section", "users");
    params.set("editUser", userId);
    params.set("userPage", String(currentPage));
    if (query.trim()) params.set("userSearch", query.trim());
    if (roleId && roleId !== "all") params.set("userRole", roleId);
    if (userType && userType !== "user") params.set("userType", userType);

    return `/users?${params.toString()}`;
  }

  function navigateToManage(event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>, href: string) {
    event.preventDefault();
    window.location.assign(href);
  }

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>Identity and access register</h2>
          <p className="subtle">People owns person designations and managed locations. Dashboard owns station mailboxes; manual roles remain only for technical exceptions.</p>
        </div>
        <div className="filters">
          <input
            className="field"
            onChange={(event) => {
              updateListParams({ nextQuery: event.target.value, page: 1 });
            }}
            placeholder="Search user or email"
            value={query}
          />
          <SearchableSelect
            key={`role-filter-${roleId}`}
            name="role_filter"
            options={[{ value: "all", label: "All roles" }, ...roleOptions]}
            defaultValue={roleId}
            onValueChange={(value) => {
              updateListParams({ nextRoleId: value || "all", page: 1 });
            }}
            placeholder="Search role"
          />
          <select
            className="select"
            onChange={(event) => {
              updateListParams({ nextUserType: event.target.value, page: 1 });
            }}
            value={userType}
          >
            <option value="all">All</option>
            <option value="user">User</option>
            <option value="location">Location</option>
          </select>
          {canAdd ? <PendingLink className="button" href="/users?section=users&addUser=1" scroll={false}>Add user</PendingLink> : null}
        </div>
      </div>
      <div className="table-wrap users-table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Emp ID</th>
              <th>Email</th>
              <th>Access identity</th>
              <th>Portals</th>
              <th>Location Scope</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {pagedUsers.length ? pagedUsers.map((user) => {
              const roleName = user.access_label || roles.find((role) => role.id === user.role_id)?.name || user.role || "-";
              const locationTags = locationScopeTags(user);
              const isLinkedLocationMaster = user.access_source === "location" || (
                ["Location Email", "Location Master"].includes(user.invite_method ?? "")
                && Boolean(user.email && locationEmails.has(user.email.trim().toLowerCase()))
              );

              return (
                <tr key={user.id}>
                  <td><strong>{user.full_name || "Unnamed user"}</strong></td>
                  <td>{user.employee_id || "-"}</td>
                  <td>{user.email || "-"}</td>
                  <td>
                    {roleName}
                    <div className="subtle">{isLinkedLocationMaster ? "Dashboard station account" : user.access_source === "people" ? "People designation" : "Manual exception"}</div>
                  </td>
                  <td>{user.portal_codes?.length ? user.portal_codes.map((code) => code === "operations" ? "OpsPulse" : code.charAt(0).toUpperCase() + code.slice(1)).join(", ") : "-"}</td>
                  <td>
                    {locationTags ? (
                      <div className="scope-tags">
                        {locationTags.map((tag) => (
                          <span className={`scope-tag ${tag.muted ? "muted" : ""}`} key={tag.label}>{tag.label}</span>
                        ))}
                      </div>
                    ) : "-"}
                  </td>
                  <td><StatusPill status={userStatus(user)} /></td>
                  <td>{user.people_profile_url
                    ? <a className="button secondary" href={user.people_profile_url}>Manage in People</a>
                    : canEdit ? (
                      <button
                        className="button secondary"
                        onClick={(event) => navigateToManage(event, editUserUrl(user.id))}
                        onPointerDown={(event) => navigateToManage(event, editUserUrl(user.id))}
                        type="button"
                      >
                        Manage
                      </button>
                    )
                    : "-"}</td>
                </tr>
              );
            }) : (
              <tr>
                <td className="empty-cell" colSpan={8}>No users match the selected filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mobile-user-cards" aria-label="Users">
        {pagedUsers.length ? pagedUsers.map((user) => {
          const roleName = user.access_label || roles.find((role) => role.id === user.role_id)?.name || user.role || "-";
          const locationTags = locationScopeTags(user);
          const isLinkedLocationMaster = user.access_source === "location" || (
            ["Location Email", "Location Master"].includes(user.invite_method ?? "")
            && Boolean(user.email && locationEmails.has(user.email.trim().toLowerCase()))
          );

          return (
            <article className="mobile-user-card" key={`mobile-${user.id}`}>
              <div className="mobile-user-card-head">
                <div>
                  <strong>{user.full_name || "Unnamed user"}</strong>
                  <span>{user.employee_id || "-"}</span>
                </div>
                <StatusPill status={userStatus(user)} />
              </div>
              <dl className="mobile-user-fields">
                <div>
                  <dt>Email</dt>
                  <dd>{user.email || "-"}</dd>
                </div>
                <div>
                  <dt>Role</dt>
                  <dd>
                    {roleName}
                    {isLinkedLocationMaster ? <span className="subtle">Location Master</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>Location scope</dt>
                  <dd>
                    {locationTags ? (
                      <div className="scope-tags">
                        {locationTags.map((tag) => (
                          <span className={`scope-tag ${tag.muted ? "muted" : ""}`} key={tag.label}>{tag.label}</span>
                        ))}
                      </div>
                    ) : "-"}
                  </dd>
                </div>
                <div><dt>Portals</dt><dd>{user.portal_codes?.length ? user.portal_codes.map((code) => code === "operations" ? "OpsPulse" : code.charAt(0).toUpperCase() + code.slice(1)).join(", ") : "-"}</dd></div>
              </dl>
              {user.people_profile_url ? <a className="button secondary mobile-user-manage" href={user.people_profile_url}>Manage in People</a> : canEdit ? (
                <button
                  className="button secondary mobile-user-manage"
                  onClick={(event) => navigateToManage(event, editUserUrl(user.id))}
                  onPointerDown={(event) => navigateToManage(event, editUserUrl(user.id))}
                  type="button"
                >
                  Manage
                </button>
              ) : null}
            </article>
          );
        }) : <div className="mobile-empty-card">No users match the selected filters.</div>}
      </div>
      {totalPages > 1 ? (
        <div className="pagination">
          <button className="pager-button" disabled={currentPage <= 1} onClick={() => updatePage(currentPage - 1)} type="button">Prev</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage >= totalPages} onClick={() => updatePage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
    </section>
  );
}

"use client";

import { useMemo, useState } from "react";
import { resendUserInvitation, updateUser } from "@/app/users/actions";
import { LocationScopeOption, LocationScopeSelect } from "@/components/location-scope-select";
import { SubmitButton } from "@/components/submit-button";
import { AddUserProfileOption, AddUserRoleOption, reportingUsersAboveRole } from "@/components/add-user-form";
import { DismissModalButton } from "@/components/dismissible-modal";
import { countryCodeOptions } from "@/lib/country-codes";

type ManageUser = {
  id: string;
  employeeId: string | null;
  fullName: string | null;
  email: string | null;
  mobileCountryCode: string | null;
  mobile: string | null;
  roleId: string | null;
  reportsToUserId: string | null;
  locationScopeIds: string[];
  isActive: boolean;
  invitationPending: boolean;
  isLocationManaged: boolean;
};

function labelForUser(user: AddUserProfileOption, roles: AddUserRoleOption[]) {
  const roleName = roles.find((role) => role.id === user.roleId)?.name;
  return [user.fullName || user.email || "Unnamed user", roleName, user.email].filter(Boolean).join(" - ");
}

export function ManageUserForm({
  returnHref = "/users",
  user,
  roles,
  users,
  locations
}: {
  returnHref?: string;
  user: ManageUser;
  roles: AddUserRoleOption[];
  users: AddUserProfileOption[];
  locations: LocationScopeOption[];
}) {
  const [roleId, setRoleId] = useState(user.roleId ?? "");
  const [reportsToUserId, setReportsToUserId] = useState(user.reportsToUserId ?? "");
  const isLocked = user.isLocationManaged;

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;
  const isLocationRole = selectedRole?.code === "LOCATION";
  const reportingUsers = useMemo(() => {
    if (selectedRole?.code === "LOCATION") {
      return users
        .filter((item) => {
          const itemRole = roles.find((role) => role.id === item.roleId);
          return item.isActive && item.id !== user.id && Boolean(itemRole) && itemRole?.code !== "LOCATION";
        })
        .sort((left, right) => labelForUser(left, roles).localeCompare(labelForUser(right, roles)));
    }
    return reportingUsersAboveRole(selectedRole, roles, users, user.id);
  }, [roles, selectedRole, user.id, users]);
  const reportingUser = users.find((item) => item.id === reportsToUserId) ?? null;
  const reportingUserRole = roles.find((role) => role.id === reportingUser?.roleId) ?? null;
  const allowedLocationIds = new Set(reportingUser?.locationScopeIds ?? []);
  const isAllLocationRole = selectedRole?.locationAccessMode === "all_locations";
  const allLocationIds = useMemo(() => locations.map((location) => location.id), [locations]);
  const scopedLocations = !selectedRole
    ? locations
    : isAllLocationRole
      ? locations
      : !reportingUser || reportingUserRole?.locationAccessMode === "all_locations"
        ? locations
        : allowedLocationIds.size
          ? locations.filter((location) => allowedLocationIds.has(location.id))
          : [];
  const selectedLocationIds = isAllLocationRole
    ? allLocationIds
    : user.locationScopeIds.filter((id) => scopedLocations.some((location) => location.id === id));

  function handleRoleChange(nextRoleId: string) {
    setRoleId(nextRoleId);
    setReportsToUserId("");
  }

  return (
    <>
      <form action={updateUser} className="form-grid">
        <input type="hidden" name="id" value={user.id} />
        <input type="hidden" name="return_href" value={returnHref} />
        {isLocked ? (
          <div className="span-2 form-note">
            This user is managed from Location Master. Update the location email, manager, or status from the location record.
          </div>
        ) : null}
        <label>Emp ID<input className="field" name="employee_id" defaultValue={user.employeeId ?? ""} disabled={isLocked} required /></label>
        <label>Full name<input className="field" name="full_name" defaultValue={user.fullName ?? ""} disabled={isLocked} required /></label>
        <label>Email<input className="field" defaultValue={user.email ?? ""} disabled /></label>
        <label>Country code
          <select className="select" name="mobile_country_code" defaultValue={user.mobileCountryCode ?? "91"} disabled={isLocked}>
            {countryCodeOptions.map((country) => (
              <option key={country.code} value={country.code}>{country.label}</option>
            ))}
          </select>
        </label>
        <label>Mobile<input className="field" inputMode="tel" maxLength={15} name="mobile" defaultValue={user.mobile ?? ""} disabled={isLocked} /></label>
        <label>Role
          <select className="select" disabled={isLocked} name="role_id" onChange={(event) => handleRoleChange(event.target.value)} required value={roleId}>
            <option value="">Select role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>{role.name}</option>
            ))}
          </select>
        </label>
        <label>Reporting manager
          <select
            className="select"
            disabled={isLocked || (!selectedRole?.parentRoleId && !isLocationRole)}
            name="reports_to_user_id"
            onChange={(event) => setReportsToUserId(event.target.value)}
            required={Boolean(selectedRole?.parentRoleId || isLocationRole)}
            value={reportsToUserId}
          >
            <option value="">
              {!selectedRole || selectedRole.parentRoleId || isLocationRole ? "Select reporting manager" : "Top level role"}
            </option>
            {reportingUsers.map((item) => (
              <option key={item.id} value={item.id}>{labelForUser(item, roles)}</option>
            ))}
          </select>
        </label>
        <label className="span-2">Location scope (optional)
          {isAllLocationRole ? (
            <LocationScopeSelect
              key={`manage-all-${roleId}`}
              defaultSelectedIds={allLocationIds}
              locations={scopedLocations}
              readOnly
            />
          ) : (
            <LocationScopeSelect
              key={`manage-scoped-${roleId}-${reportsToUserId}`}
              defaultSelectedIds={selectedLocationIds}
              locations={scopedLocations}
              disabled={isLocked}
              readOnly={isLocked}
            />
          )}
        </label>
        <label>Status
          <select className="select" name="is_active" defaultValue={user.isActive ? "active" : "inactive"} disabled={isLocked}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <div className="form-actions span-2">
          {!isLocked ? <SubmitButton>Save changes</SubmitButton> : null}
          <DismissModalButton className="button secondary">Cancel</DismissModalButton>
        </div>
      </form>
      {user.invitationPending && !isLocked ? (
        <form action={resendUserInvitation} className="inline-form">
          <input type="hidden" name="id" value={user.id} />
          <SubmitButton className="button secondary" pendingText="Sending">Resend invitation</SubmitButton>
        </form>
      ) : null}
    </>
  );
}

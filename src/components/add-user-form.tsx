"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LocationScopeOption, LocationScopeSelect } from "@/components/location-scope-select";
import { SubmitButton } from "@/components/submit-button";
import { createUser } from "@/app/users/actions";
import { countryCodeOptions } from "@/lib/country-codes";

export type AddUserRoleOption = {
  id: string;
  code: string;
  locationAccessMode: "all_locations" | "role_based";
  name: string;
  parentRoleId: string | null;
};

export type AddUserProfileOption = {
  id: string;
  fullName: string | null;
  email: string | null;
  isActive: boolean;
  roleId: string | null;
  locationScopeIds: string[];
};

export type AddUserDesignationOption = {
  id: string;
  code: string;
  name: string;
};

export type AddUserPersonOption = {
  id: string;
  designationId: string;
  employeeId: string | null;
  fullName: string | null;
  email: string | null;
  mobileCountryCode: string | null;
  mobile: string | null;
};

function labelForUser(user: AddUserProfileOption, roles: AddUserRoleOption[]) {
  const roleName = roles.find((role) => role.id === user.roleId)?.name;
  return [user.fullName || user.email || "Unnamed user", roleName, user.email].filter(Boolean).join(" - ");
}

export function reportingUsersAboveRole(
  selectedRole: AddUserRoleOption | null,
  roles: AddUserRoleOption[],
  users: AddUserProfileOption[],
  excludeUserId?: string
) {
  const roleOrder: string[] = [];
  const visited = new Set<string>();
  let parentRoleId = selectedRole?.parentRoleId;

  while (parentRoleId && !visited.has(parentRoleId)) {
    visited.add(parentRoleId);
    roleOrder.push(parentRoleId);
    parentRoleId = roles.find((role) => role.id === parentRoleId)?.parentRoleId ?? null;
  }

  const orderByRole = new Map(roleOrder.map((id, index) => [id, index]));
  return users
    .filter((user) => user.isActive && user.id !== excludeUserId && user.roleId && orderByRole.has(user.roleId))
    .sort((left, right) => {
      const roleDifference = (orderByRole.get(left.roleId ?? "") ?? 999) - (orderByRole.get(right.roleId ?? "") ?? 999);
      return roleDifference || labelForUser(left, roles).localeCompare(labelForUser(right, roles));
    });
}

const draftKey = "dropx:add-user-draft";

type AddUserDraft = {
  designationId: string;
  personId: string;
  employeeId: string;
  fullName: string;
  email: string;
  mobileCountryCode: string;
  mobile: string;
  roleId: string;
  reportsToUserId: string;
  locationScopeIds: string[];
  sendInvitation: boolean;
};

const emptyDraft: AddUserDraft = {
  designationId: "",
  personId: "",
  employeeId: "",
  fullName: "",
  email: "",
  mobileCountryCode: "91",
  mobile: "",
  roleId: "",
  reportsToUserId: "",
  locationScopeIds: [],
  sendInvitation: true
};

function parseLocationScope(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function AddUserForm({
  designations,
  people,
  roles,
  users,
  locations
}: {
  designations: AddUserDesignationOption[];
  people: AddUserPersonOption[];
  roles: AddUserRoleOption[];
  users: AddUserProfileOption[];
  locations: LocationScopeOption[];
}) {
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState<AddUserDraft>(emptyDraft);
  const [designationId, setDesignationId] = useState(emptyDraft.designationId);
  const [personId, setPersonId] = useState(emptyDraft.personId);
  const [roleId, setRoleId] = useState(emptyDraft.roleId);
  const [reportsToUserId, setReportsToUserId] = useState(emptyDraft.reportsToUserId);

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;
  const isLocationRole = selectedRole?.code === "LOCATION";
  const reportingUsers = useMemo(() => {
    if (selectedRole?.code === "LOCATION") {
      return users
        .filter((user) => {
          const userRole = roles.find((role) => role.id === user.roleId);
          return user.isActive && Boolean(userRole) && userRole?.code !== "LOCATION";
        })
        .sort((left, right) => labelForUser(left, roles).localeCompare(labelForUser(right, roles)));
    }
    return reportingUsersAboveRole(selectedRole, roles, users);
  }, [roles, selectedRole, users]);
  const reportingUser = users.find((user) => user.id === reportsToUserId) ?? null;
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
  const designationPeople = useMemo(
    () => people.filter((person) => person.designationId === designationId),
    [designationId, people]
  );
  const selectedPerson = people.find((person) => person.id === personId) ?? null;

  useEffect(() => {
    if (searchParams.get("userNotice")) {
      sessionStorage.removeItem(draftKey);
      setDraft(emptyDraft);
      setDesignationId("");
      setPersonId("");
      setRoleId("");
      setReportsToUserId("");
      return;
    }

    if (!searchParams.get("userError")) return;

    const saved = sessionStorage.getItem(draftKey);
    if (!saved) return;

    try {
      const nextDraft = { ...emptyDraft, ...JSON.parse(saved) } as AddUserDraft;
      setDraft(nextDraft);
      setDesignationId(nextDraft.designationId);
      setPersonId(nextDraft.personId);
      setRoleId(nextDraft.roleId);
      setReportsToUserId(nextDraft.reportsToUserId);
    } catch {
      sessionStorage.removeItem(draftKey);
    }
  }, [searchParams]);

  function updateDraft(field: keyof AddUserDraft, value: string | boolean | string[]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function handleRoleChange(nextRoleId: string) {
    setRoleId(nextRoleId);
    setReportsToUserId("");
    setDraft((current) => ({
      ...current,
      roleId: nextRoleId,
      reportsToUserId: "",
      locationScopeIds: []
    }));
  }

  function handleDesignationChange(nextDesignationId: string) {
    setDesignationId(nextDesignationId);
    setPersonId("");
    setDraft((current) => ({
      ...current,
      designationId: nextDesignationId,
      personId: "",
      employeeId: "",
      fullName: "",
      email: "",
      mobileCountryCode: "91",
      mobile: ""
    }));
  }

  function handlePersonChange(nextPersonId: string) {
    setPersonId(nextPersonId);
    const person = people.find((option) => option.id === nextPersonId);
    const workEmail = person?.email?.trim().toLowerCase().endsWith("@dropxlogistics.com")
      ? person.email.trim().toLowerCase()
      : "";
    setDraft((current) => ({
      ...current,
      personId: nextPersonId,
      employeeId: person?.employeeId ?? "",
      fullName: person?.fullName ?? "",
      email: workEmail,
      mobileCountryCode: person?.mobileCountryCode ?? "91",
      mobile: person?.mobile ?? ""
    }));
  }

  function saveDraft(formData: FormData) {
    const nextDraft: AddUserDraft = {
      designationId: String(formData.get("designation_id") ?? ""),
      personId: String(formData.get("people_employee_id") ?? ""),
      employeeId: String(formData.get("employee_id") ?? ""),
      fullName: String(formData.get("full_name") ?? ""),
      email: String(formData.get("email") ?? ""),
      mobileCountryCode: String(formData.get("mobile_country_code") ?? "91"),
      mobile: String(formData.get("mobile") ?? ""),
      roleId: String(formData.get("role_id") ?? ""),
      reportsToUserId: String(formData.get("reports_to_user_id") ?? ""),
      locationScopeIds: parseLocationScope(formData.get("location_scope_ids")),
      sendInvitation: formData.get("send_invitation") === "yes"
    };

    sessionStorage.setItem(draftKey, JSON.stringify(nextDraft));
  }

  return (
    <form action={createUser} onSubmit={(event) => saveDraft(new FormData(event.currentTarget))}>
      <div className="form-grid three">
        <label>People designation
          <select className="select" name="designation_id" onChange={(event) => handleDesignationChange(event.target.value)} required value={designationId}>
            <option value="">Select designation</option>
            {designations.map((designation) => <option key={designation.id} value={designation.id}>{designation.name} ({designation.code})</option>)}
          </select>
        </label>
        <label>Person from People
          <select className="select" disabled={!designationId} name="people_employee_id" onChange={(event) => handlePersonChange(event.target.value)} required value={personId}>
            <option value="">{designationId ? "Select person" : "Select designation first"}</option>
            {designationPeople.map((person) => <option key={person.id} value={person.id}>{person.fullName || "Unnamed employee"} · {person.employeeId || "No employee ID"}</option>)}
          </select>
        </label>
        <label>DropX login email
          <input className="field" name="email" onChange={(event) => updateDraft("email", event.target.value)} pattern="[^@ ]+@dropxlogistics[.]com" placeholder="name@dropxlogistics.com" required type="email" value={draft.email} />
          {selectedPerson?.email && !selectedPerson.email.toLowerCase().endsWith("@dropxlogistics.com") ? <small>People email: {selectedPerson.email}. Enter the company email for portal access.</small> : null}
        </label>
        <label>Emp ID<input className="field" name="employee_id" readOnly required value={draft.employeeId} /></label>
        <label>Full name<input className="field" name="full_name" readOnly required value={draft.fullName} /></label>
        <label>Country code
          <select className="select" disabled name="mobile_country_code" value={draft.mobileCountryCode}>
            {countryCodeOptions.map((country) => (
              <option key={country.code} value={country.code}>{country.label}</option>
            ))}
          </select>
          <input name="mobile_country_code" type="hidden" value={draft.mobileCountryCode} />
        </label>
        <label>Mobile<input className="field" name="mobile" readOnly value={draft.mobile} /></label>
        <label>Product access role
          <select
            className="select"
            name="role_id"
            onChange={(event) => handleRoleChange(event.target.value)}
            required
            value={roleId}
          >
            <option value="">Select role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>{role.name}</option>
            ))}
          </select>
        </label>
        <label>Reporting manager
          <select
            className="select"
            disabled={!selectedRole?.parentRoleId && !isLocationRole}
            name="reports_to_user_id"
            onChange={(event) => {
              setReportsToUserId(event.target.value);
              updateDraft("reportsToUserId", event.target.value);
            }}
            required={Boolean(selectedRole?.parentRoleId || isLocationRole)}
            value={reportsToUserId}
          >
            <option value="">
              {!selectedRole || selectedRole.parentRoleId || isLocationRole ? "Select reporting manager" : "Top level role"}
            </option>
            {reportingUsers.map((user) => (
              <option key={user.id} value={user.id}>{labelForUser(user, roles)}</option>
            ))}
          </select>
        </label>
        <label>Location scope (optional)
          {isAllLocationRole ? (
            <LocationScopeSelect
              key={`all-${roleId}`}
              defaultSelectedIds={allLocationIds}
              locations={scopedLocations}
              readOnly
            />
          ) : (
            <LocationScopeSelect
              defaultSelectedIds={draft.locationScopeIds}
              key={`scoped-${roleId}-${reportsToUserId}-${draft.locationScopeIds.join("-")}`}
              locations={scopedLocations}
            />
          )}
        </label>
      </div>
      <div className="add-user-actions">
        <label className="check-row">
          <input
            checked={draft.sendInvitation}
            className="matrix-checkbox"
            name="send_invitation"
            onChange={(event) => updateDraft("sendInvitation", event.target.checked)}
            type="checkbox"
            value="yes"
          />
          <span>Send email invitation</span>
        </label>
        <SubmitButton disabled={!roles.length} disabledText="Add role first">Save user</SubmitButton>
      </div>
    </form>
  );
}

"use client";

import { useMemo, useState } from "react";
import { saveWorkspaceAccountMapping } from "@/app/settings/google-workspace/actions";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";

export type WorkspaceDirectoryAccount = {
  id: string;
  primaryEmail: string;
  fullName: string;
  accountType: string;
  accountState: string;
  sourceType: string | null;
  sourceRecordId: string | null;
  profileId: string | null;
  orgUnitPath: string;
  lastSyncedAt: string | null;
  mappingSource: string;
};

export type WorkspaceEmployeeOption = {
  id: string;
  employeeCode: string;
  fullName: string;
  designationCode: string | null;
  designationName: string | null;
  locationCode: string | null;
  locationName: string | null;
  isActive: boolean;
};

export type WorkspaceLocationOption = {
  id: string;
  locationCode: string;
  locationName: string | null;
  email: string | null;
  isActive: boolean;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(new Date(value));
}

function targetFor(account: WorkspaceDirectoryAccount) {
  if (account.sourceType === "employee" && account.sourceRecordId) return `employee:${account.sourceRecordId}`;
  if (account.sourceType === "location" && account.sourceRecordId) return `location:${account.sourceRecordId}`;
  if (account.accountType === "service") return "service";
  if (account.accountType === "unmatched" && !account.profileId) return "unmatched";
  return "";
}

function identityType(account: WorkspaceDirectoryAccount) {
  if (account.sourceType === "employee") return "Person";
  if (account.sourceType === "location") return "Location";
  if (account.accountType === "service") return "Service";
  if (account.accountType === "person") return "Person";
  return "Unmapped";
}

export function GoogleWorkspaceDirectoryMapping({
  accounts,
  employees,
  locations,
  canEdit
}: {
  accounts: WorkspaceDirectoryAccount[];
  employees: WorkspaceEmployeeOption[];
  locations: WorkspaceLocationOption[];
  canEdit: boolean;
}) {
  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const locationById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const firstNeedsMapping = accounts.find((account) => !targetFor(account) || targetFor(account) === "unmatched");
  const [selectedAccountId, setSelectedAccountId] = useState(firstNeedsMapping?.id ?? accounts[0]?.id ?? "");
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  const [selectedTarget, setSelectedTarget] = useState(selectedAccount ? targetFor(selectedAccount) : "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  function selectAccount(account: WorkspaceDirectoryAccount) {
    setSelectedAccountId(account.id);
    setSelectedTarget(targetFor(account));
  }

  function mappingDetails(account: WorkspaceDirectoryAccount) {
    if (account.sourceType === "employee" && account.sourceRecordId) {
      const employee = employeeById.get(account.sourceRecordId);
      return {
        record: employee ? `${employee.employeeCode} · ${employee.fullName}` : "Employee record unavailable",
        subrecord: "DropX Employee Master",
        designation: employee?.designationName
          ? `${employee.designationName}${employee.designationCode ? ` (${employee.designationCode})` : ""}`
          : "—",
        location: employee?.locationCode
          ? `${employee.locationCode}${employee.locationName ? ` · ${employee.locationName}` : ""}`
          : "—",
        status: employee ? "Mapped" : "Mapping missing"
      };
    }
    if (account.sourceType === "location" && account.sourceRecordId) {
      const location = locationById.get(account.sourceRecordId);
      return {
        record: location ? `${location.locationCode} · ${location.locationName || "Location"}` : "Location record unavailable",
        subrecord: location?.email || "Location email master",
        designation: "Not applicable",
        location: location?.locationCode || "—",
        status: location ? "Mapped" : "Mapping missing"
      };
    }
    if (account.accountType === "service") {
      return {
        record: "Shared / service identity",
        subrecord: "No employee or location ownership",
        designation: "Not applicable",
        location: "—",
        status: "Classified"
      };
    }
    if (account.accountType === "person" && account.profileId) {
      return {
        record: "Portal profile only",
        subrecord: "Employee ID must be mapped",
        designation: "—",
        location: "—",
        status: "Needs employee ID"
      };
    }
    return {
      record: "No DropX master record",
      subrecord: "Select an employee, location or service identity",
      designation: "—",
      location: "—",
      status: "Needs mapping"
    };
  }

  const filteredAccounts = accounts.filter((account) => {
    const details = mappingDetails(account);
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery || [
      account.primaryEmail,
      account.fullName,
      identityType(account),
      details.record,
      details.designation,
      details.location
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (filter === "all") return true;
    if (filter === "mapped") return details.status === "Mapped" || details.status === "Classified";
    if (filter === "attention") return details.status !== "Mapped" && details.status !== "Classified";
    return identityType(account).toLowerCase() === filter;
  });

  const mappedCount = accounts.filter((account) => {
    const status = mappingDetails(account).status;
    return status === "Mapped" || status === "Classified";
  }).length;
  const attentionCount = accounts.length - mappedCount;

  return (
    <section className="panel workspace-mapping-panel" id="workspace-directory">
      <div className="panel-head toolbar">
        <div>
          <h2>Google Mail IDs &amp; Identity Mapping</h2>
          <p className="subtle">Every Google Workspace address is listed here. Super Admin maps it to one Employee ID, one Location ID, or an explicit service identity.</p>
        </div>
        <div className="workspace-mapping-counts">
          <StatusPill status={`${mappedCount} mapped`} />
          <StatusPill status={`${attentionCount} need mapping`} />
        </div>
      </div>

      <form action={saveWorkspaceAccountMapping} className="workspace-mapping-editor">
        <div className="workspace-mapping-editor-copy">
          <strong>Map or correct an identity</strong>
          <span>DropX masters remain the source of truth. This does not rename, suspend or delete the Google account.</span>
        </div>
        <label>
          Google mail ID
          <select
            className="field"
            name="account_id"
            onChange={(event) => {
              const account = accounts.find((row) => row.id === event.target.value);
              if (account) selectAccount(account);
            }}
            required
            value={selectedAccountId}
          >
            {!accounts.length ? <option value="">No synced accounts</option> : null}
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.primaryEmail} · {account.fullName}</option>)}
          </select>
        </label>
        <label>
          DropX identity mapping
          <select className="field" name="mapping_target" onChange={(event) => setSelectedTarget(event.target.value)} required value={selectedTarget}>
            <option value="">Select an employee, location or identity type</option>
            <optgroup label="Employees">
              {employees.map((employee) => (
                <option key={employee.id} value={`employee:${employee.id}`}>
                  {employee.employeeCode} · {employee.fullName} · {employee.designationCode || "No designation"} · {employee.locationCode || "No location"}{employee.isActive ? "" : " · Inactive"}
                </option>
              ))}
            </optgroup>
            <optgroup label="Locations">
              {locations.map((location) => (
                <option key={location.id} value={`location:${location.id}`}>
                  {location.locationCode} · {location.locationName || "Location"}{location.isActive ? "" : " · Inactive"}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other identities">
              <option value="service">Service / shared account</option>
              <option value="unmatched">Leave deliberately unmapped</option>
            </optgroup>
          </select>
        </label>
        <SubmitButton disabled={!canEdit || !selectedAccount || !selectedTarget} pendingText="Saving mapping">Save mapping</SubmitButton>
      </form>

      <div className="workspace-directory-toolbar">
        <label>
          Search directory
          <input className="field" onChange={(event) => setQuery(event.target.value)} placeholder="Email, Employee ID, name, designation or location" type="search" value={query} />
        </label>
        <label>
          Mapping status
          <select className="field" onChange={(event) => setFilter(event.target.value)} value={filter}>
            <option value="all">All Google mail IDs</option>
            <option value="attention">Needs mapping</option>
            <option value="mapped">Mapped / classified</option>
            <option value="person">People</option>
            <option value="location">Locations</option>
            <option value="service">Service accounts</option>
            <option value="unmapped">Unmapped</option>
          </select>
        </label>
        <span>{filteredAccounts.length} of {accounts.length} accounts</span>
      </div>

      <div className="table-wrap workspace-directory-table">
        <table>
          <thead>
            <tr>
              <th>Google mail ID</th>
              <th>Identity type</th>
              <th>Employee / location ID</th>
              <th>Designation</th>
              <th>Assigned location</th>
              <th>Google state</th>
              <th>Mapping</th>
              <th>Control</th>
            </tr>
          </thead>
          <tbody>
            {filteredAccounts.map((account) => {
              const details = mappingDetails(account);
              return (
                <tr className={account.id === selectedAccountId ? "selected" : ""} key={account.id}>
                  <td><strong>{account.primaryEmail}</strong><small>{account.fullName}<br />OU: {account.orgUnitPath}</small></td>
                  <td>{identityType(account)}<small>{account.mappingSource}</small></td>
                  <td><strong>{details.record}</strong><small>{details.subrecord}</small></td>
                  <td>{details.designation}</td>
                  <td>{details.location}</td>
                  <td><StatusPill status={account.accountState} /><small>{formatDate(account.lastSyncedAt)}</small></td>
                  <td><StatusPill status={details.status} /></td>
                  <td><button className="button secondary compact" onClick={() => selectAccount(account)} type="button">Review</button></td>
                </tr>
              );
            })}
            {!filteredAccounts.length ? <tr><td className="empty-cell" colSpan={8}>No Google mail IDs match this search or filter.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

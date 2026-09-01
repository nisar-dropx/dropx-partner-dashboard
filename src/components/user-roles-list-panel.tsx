"use client";

import { useState } from "react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";

export type UserRolesListRole = {
  id: string;
  code: string;
  name: string;
  location_access_mode: "all_locations" | "role_based";
  parent_role_id: string | null;
  is_system: boolean;
  is_active: boolean;
  permissionSummary: string;
};

const PAGE_SIZE = 10;

export function UserRolesListPanel({
  canAdd,
  canEdit,
  roles
}: {
  canAdd: boolean;
  canEdit: boolean;
  roles: UserRolesListRole[];
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(roles.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRoles = roles.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>User role list</h2>
          <p className="subtle">Roles are saved with hidden IDs. Code and name can stay editable later without breaking assigned users.</p>
        </div>
        {canAdd ? <PendingLink className="button" href="/users?section=roles&addRole=1" scroll={false}>Add user role</PendingLink> : null}
      </div>
      <div className="table-wrap">
        <table style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th>Role code</th>
              <th>Role name</th>
              <th>Reporting role</th>
              <th>Location access</th>
              <th>Permission summary</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {pagedRoles.length ? pagedRoles.map((role) => (
              <tr key={role.id}>
                <td><strong>{role.code}</strong></td>
                <td>{role.name}</td>
                <td>{role.code === "LOCATION" ? "-" : roles.find((item) => item.id === role.parent_role_id)?.name ?? "Top level"}</td>
                <td>{role.location_access_mode === "all_locations" ? "All locations" : "Role based"}</td>
                <td>{role.permissionSummary}</td>
                <td><StatusPill status={role.is_active ? "Active" : "Inactive"} /></td>
                <td>
                  {!canEdit ? (
                    "-"
                  ) : role.is_system ? (
                    <span className="button secondary disabled">Locked</span>
                  ) : (
                    <PendingLink className="button secondary" href={`/users?section=roles&editRole=${role.id}`} scroll={false}>Manage</PendingLink>
                  )}
                </td>
              </tr>
            )) : (
              <tr>
                <td className="empty-cell" colSpan={7}>No user roles added yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <div className="pagination">
          <button className="pager-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
    </section>
  );
}

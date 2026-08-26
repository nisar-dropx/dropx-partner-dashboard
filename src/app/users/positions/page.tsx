import { AppShell } from "@/components/app-shell";
import { LocationScopeSelect } from "@/components/location-scope-select";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { isMissingPositionAccessSchema } from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assignActingCover,
  assignPermanentPosition,
  endAssignment,
  savePosition,
  setPositionStatus
} from "./actions";

type PositionRow = {
  id: string;
  code: string;
  name: string;
  designation_id: string | null;
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
  source_employee_id: string | null;
  assignment_type: "permanent" | "acting";
  valid_from: string;
  valid_until: string | null;
  reason: string | null;
  is_active: boolean;
};

type PositionPageProps = {
  searchParams?: { edit?: string; error?: string; notice?: string };
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function inForce(assignment: AssignmentRow) {
  const day = today();
  return assignment.is_active && assignment.valid_from <= day && (!assignment.valid_until || assignment.valid_until >= day);
}

function scopeLabel(position: PositionRow, stationCodeById: Map<string, string>) {
  if (position.location_access_mode === "all_locations") return "All locations";
  const codes = (position.location_scope_ids ?? []).map((id) => stationCodeById.get(id)).filter(Boolean);
  if (!codes.length) return "No locations";
  return codes.length <= 3 ? codes.join(", ") : `${codes.slice(0, 3).join(", ")} +${codes.length - 3}`;
}

export default async function PositionsPage({ searchParams }: PositionPageProps) {
  const authorization = await requirePagePermission("users", "access");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) {
    return (
      <AppShell active="Positions & Delegation" pageCode="users">
        <PageHead eyebrow="Users & Access" title="Positions & Delegation" subtitle="Database service is not configured." />
      </AppShell>
    );
  }

  const [positionsResult, assignmentsResult, rolesResult, designationsResult, stationsResult, employeesResult, profilesResult] = await Promise.all([
    supabaseAdmin.from("org_positions").select("id, code, name, designation_id, role_id, reports_to_position_id, location_access_mode, location_scope_ids, is_active")
      .eq("company_id", companyId).order("name"),
    supabaseAdmin.from("position_assignments").select("id, position_id, profile_id, source_employee_id, assignment_type, valid_from, valid_until, reason, is_active")
      .eq("company_id", companyId).eq("is_active", true).order("created_at", { ascending: false }),
    supabaseAdmin.from("user_roles").select("id, code, name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("designations").select("id, code, name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("stations").select("id, station_code, station_name, city, state").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("employees").select("id, employee_code, full_name, email, location_id, designation_id, org_position_id, is_active, profile_completion_status")
      .eq("company_id", companyId).eq("is_active", true).order("full_name"),
    supabaseAdmin.from("profiles").select("id, full_name, email").eq("company_id", companyId)
  ]);
  const dataError = [positionsResult.error, assignmentsResult.error, rolesResult.error, designationsResult.error, stationsResult.error, employeesResult.error, profilesResult.error].find(Boolean);
  if (dataError && !isMissingPositionAccessSchema(dataError)) throw new Error(dataError.message);

  const schemaMissing = Boolean(dataError && isMissingPositionAccessSchema(dataError));
  const positions = (positionsResult.data ?? []) as PositionRow[];
  const assignments = (assignmentsResult.data ?? []) as AssignmentRow[];
  const roles = rolesResult.data ?? [];
  const designations = designationsResult.data ?? [];
  const stations = stationsResult.data ?? [];
  const employees = (employeesResult.data ?? []).filter((employee) => (
    employee.email && String(employee.profile_completion_status ?? "active").toLowerCase() === "active"
  ));
  const profiles = profilesResult.data ?? [];
  const editingPosition = positions.find((position) => position.id === searchParams?.edit) ?? null;

  const roleById = new Map(roles.map((role) => [role.id, role]));
  const designationById = new Map(designations.map((designation) => [designation.id, designation]));
  const stationCodeById = new Map(stations.map((station) => [station.id, station.station_code]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const activeAssignments = assignments.filter(inForce);
  const permanentByPosition = new Map(activeAssignments.filter((assignment) => assignment.assignment_type === "permanent").map((assignment) => [assignment.position_id, assignment]));
  const actingAssignments = activeAssignments.filter((assignment) => assignment.assignment_type === "acting");
  const vacantCount = positions.filter((position) => position.is_active && !permanentByPosition.has(position.id)).length;
  const locationOptions = stations.map((station) => ({
    id: station.id,
    code: station.station_code,
    name: station.station_name ?? station.station_code,
    city: station.city,
    state: station.state
  }));
  const assignableEmployees = employees.filter((employee) => !employee.org_position_id);

  return (
    <AppShell active="Positions & Delegation" pageCode="users">
      <PageHead
        eyebrow="Users & Access"
        title="Positions & Delegation"
        subtitle="Define access once. People inherit it automatically, including time-bound leave cover."
        action={<PendingLink className="button secondary" href="/users?section=roles">Manage role permissions</PendingLink>}
      />

      {schemaMissing ? (
        <section className="panel message-panel error"><div className="panel-body">
          <strong>Position Access setup is pending</strong>
          <p className="subtle" style={{ marginTop: 6 }}>Apply scripts/position_access_v1.sql, then refresh this page.</p>
        </div></section>
      ) : null}
      {searchParams?.error || searchParams?.notice ? (
        <section className={`panel message-panel ${searchParams.error ? "error" : "success"}`}><div className="panel-body">
          <strong>{searchParams.error ? "Action required" : "Completed"}</strong>
          <p className="subtle" style={{ marginTop: 6 }}>{searchParams.error ?? searchParams.notice}</p>
        </div></section>
      ) : null}

      {!schemaMissing ? <>
        <section className="panel">
          <div className="panel-head"><div><h2>Access overview</h2><p className="subtle">Current organisation access state</p></div></div>
          <div className="panel-body form-grid three">
            <div><span className="subtle">Active positions</span><h2>{positions.filter((position) => position.is_active).length}</h2></div>
            <div><span className="subtle">Vacant positions</span><h2>{vacantCount}</h2></div>
            <div><span className="subtle">Acting covers now</span><h2>{actingAssignments.length}</h2></div>
          </div>
        </section>

        {authorization.permissions.users?.canAdd || authorization.permissions.users?.canEdit ? (
          <section className="panel">
            <div className="panel-head"><div><h2>{editingPosition ? "Edit position" : "Create position"}</h2><p className="subtle">Role permissions stay in User Roles; the position adds reporting and operational scope.</p></div>
              {editingPosition ? <PendingLink className="button secondary compact" href="/users/positions">Cancel edit</PendingLink> : null}
            </div>
            <form action={savePosition} className="panel-body form-grid three">
              {editingPosition ? <input type="hidden" name="id" value={editingPosition.id} /> : null}
              <label>Position code<input className="field" name="code" defaultValue={editingPosition?.code ?? ""} placeholder="Example: KOZA-DL" required /></label>
              <label>Position name<input className="field" name="name" defaultValue={editingPosition?.name ?? ""} placeholder="Example: KOZA Delivery Lead" required /></label>
              <label>People designation<select className="select" name="designation_id" defaultValue={editingPosition?.designation_id ?? ""}><option value="">Any designation</option>{designations.map((designation) => <option key={designation.id} value={designation.id}>{designation.name} ({designation.code})</option>)}</select></label>
              <label>Access role<select className="select" name="role_id" defaultValue={editingPosition?.role_id ?? ""} required><option value="" disabled>Select role</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} ({role.code})</option>)}</select></label>
              <label>Reports to position<select className="select" name="reports_to_position_id" defaultValue={editingPosition?.reports_to_position_id ?? ""}><option value="">Top-level / none</option>{positions.filter((position) => position.id !== editingPosition?.id && position.is_active).map((position) => <option key={position.id} value={position.id}>{position.name} ({position.code})</option>)}</select></label>
              <label>Location access<select className="select" name="location_access_mode" defaultValue={editingPosition?.location_access_mode ?? "selected"}><option value="selected">Selected locations</option><option value="all_locations">All locations</option></select></label>
              <label className="span-3">Operational location scope<LocationScopeSelect locations={locationOptions} defaultSelectedIds={editingPosition?.location_scope_ids ?? []} /></label>
              <div className="form-actions align-right span-3"><SubmitButton>{editingPosition ? "Save position" : "Create position"}</SubmitButton></div>
            </form>
          </section>
        ) : null}

        {authorization.permissions.users?.canEdit ? <section className="panel">
          <div className="panel-head"><div><h2>Assign people</h2><p className="subtle">Permanent assignment sends an invite when needed. Temporary cover adds access only for the selected dates.</p></div></div>
          <div className="panel-body form-grid two">
            <form action={assignPermanentPosition} className="form-grid">
              <h3>Permanent occupant</h3>
              <label>Vacant position<select className="select" name="position_id" defaultValue="" required><option value="" disabled>Select position</option>{positions.filter((position) => position.is_active && !permanentByPosition.has(position.id)).map((position) => <option key={position.id} value={position.id}>{position.name} ({position.code})</option>)}</select></label>
              <label>Person from People<select className="select" name="employee_id" defaultValue="" required><option value="" disabled>Select employee</option>{assignableEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name} · {employee.employee_code} · {employee.email}</option>)}</select></label>
              <label>Reason<input className="field" name="reason" defaultValue="Position assignment" /></label>
              <div className="form-actions align-right"><SubmitButton disabled={!positions.some((position) => position.is_active && !permanentByPosition.has(position.id)) || !assignableEmployees.length}>Assign position</SubmitButton></div>
            </form>
            <form action={assignActingCover} className="form-grid">
              <h3>Temporary leave cover</h3>
              <label>Position to cover<select className="select" name="position_id" defaultValue="" required><option value="" disabled>Select occupied position</option>{positions.filter((position) => position.is_active && permanentByPosition.has(position.id)).map((position) => <option key={position.id} value={position.id}>{position.name} ({position.code})</option>)}</select></label>
              <label>Covering person<select className="select" name="employee_id" defaultValue="" required><option value="" disabled>Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name} · {employee.employee_code}</option>)}</select></label>
              <label>From<input className="field" name="valid_from" type="date" min={today()} required /></label>
              <label>Until<input className="field" name="valid_until" type="date" min={today()} required /></label>
              <label>Reason<input className="field" name="reason" placeholder="Example: Annual leave cover" required /></label>
              <div className="form-actions align-right"><SubmitButton>Schedule cover</SubmitButton></div>
            </form>
          </div>
        </section> : null}

        <section className="panel">
          <div className="panel-head"><div><h2>Position master</h2><p className="subtle">{positions.length} positions</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>Position</th><th>Designation / Role</th><th>Scope</th><th>Reports to</th><th>Occupant</th><th>Status</th>{authorization.permissions.users?.canEdit ? <th>Action</th> : null}</tr></thead><tbody>
            {positions.map((position) => {
              const occupant = permanentByPosition.get(position.id);
              const profile = occupant ? profileById.get(occupant.profile_id) : null;
              return <tr key={position.id}>
                <td><strong>{position.name}</strong><br /><span className="subtle">{position.code}</span></td>
                <td>{designationById.get(position.designation_id ?? "")?.name ?? "Any designation"}<br /><span className="subtle">{roleById.get(position.role_id)?.name ?? "Role unavailable"}</span></td>
                <td>{scopeLabel(position, stationCodeById)}</td>
                <td>{positionById.get(position.reports_to_position_id ?? "")?.name ?? "—"}</td>
                <td>{profile?.full_name ?? "Vacant"}<br /><span className="subtle">{profile?.email ?? "—"}</span></td>
                <td><span className={`status-pill ${position.is_active ? "good" : "neutral"}`}>{position.is_active ? "Active" : "Inactive"}</span></td>
                {authorization.permissions.users?.canEdit ? <td><div className="table-actions">
                  <PendingLink className="button secondary compact" href={`/users/positions?edit=${position.id}`} scroll={false}>Edit</PendingLink>
                  <form action={setPositionStatus}><input type="hidden" name="position_id" value={position.id} /><input type="hidden" name="is_active" value={String(!position.is_active)} /><SubmitButton className="button secondary compact">{position.is_active ? "Deactivate" : "Activate"}</SubmitButton></form>
                </div></td> : null}
              </tr>;
            })}
            {!positions.length ? <tr><td className="empty-cell" colSpan={authorization.permissions.users?.canEdit ? 7 : 6}>No positions created yet.</td></tr> : null}
          </tbody></table></div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>Active assignments</h2><p className="subtle">Permanent occupants and scheduled temporary cover</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>Position</th><th>Person</th><th>Type</th><th>Effective dates</th><th>Reason</th>{authorization.permissions.users?.canEdit ? <th>Action</th> : null}</tr></thead><tbody>
            {assignments.map((assignment) => {
              const profile = profileById.get(assignment.profile_id);
              return <tr key={assignment.id}>
                <td><strong>{positionById.get(assignment.position_id)?.name ?? "Unknown"}</strong></td>
                <td>{profile?.full_name ?? profile?.email ?? "Unknown user"}</td>
                <td><span className={`status-pill ${assignment.assignment_type === "acting" ? "warn" : "good"}`}>{assignment.assignment_type === "acting" ? "Acting cover" : "Permanent"}</span></td>
                <td>{formatDashboardDate(assignment.valid_from)}{assignment.valid_until ? ` to ${formatDashboardDate(assignment.valid_until)}` : " onward"}</td>
                <td>{assignment.reason ?? "—"}</td>
                {authorization.permissions.users?.canEdit ? <td><form action={endAssignment}><input type="hidden" name="assignment_id" value={assignment.id} /><SubmitButton className="button danger compact" confirmMessage="End this assignment and restore the person's previous access?" confirmSubmitText="End assignment">End</SubmitButton></form></td> : null}
              </tr>;
            })}
            {!assignments.length ? <tr><td className="empty-cell" colSpan={authorization.permissions.users?.canEdit ? 6 : 5}>No active assignments.</td></tr> : null}
          </tbody></table></div>
        </section>
      </> : null}
    </AppShell>
  );
}

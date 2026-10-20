import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { headers } from "next/headers";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFinanceHostName } from "@/lib/finance/surface";
import { paymentRoutingDay } from "@/lib/payment-delegation-policy";
import { roleIdsWithPageEditAccess } from "@/lib/position-access";
import {
  PAYOUT_DISPUTE_WORKFLOW_MAX_CANDIDATES,
  PAYOUT_DISPUTE_WORKFLOW_STAGES,
  validateWorkflowSelection,
  type PayoutDisputeWorkflowSelection
} from "@/lib/payout-dispute-workflow-settings";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { removePayoutDisputeWorkflowOverride, savePayoutDisputeWorkflow } from "./actions";

type RoleRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  location_access_mode: "selected" | "all_locations" | null;
};

type StationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  is_active: boolean;
};

type WorkflowRow = {
  id: string;
  station_id: string | null;
  initial_approver_role_ids: string[] | null;
  final_approver_role_ids: string[] | null;
  processor_role_ids: string[] | null;
  is_active: boolean;
  version: number;
  updated_at: string;
};

type CandidatePerson = {
  id: string;
  name: string;
  email: string | null;
  dashboardScope: CandidateScope | null;
  opsScope: CandidateScope | null;
};

type CandidateScope = {
  allLocations: boolean;
  locationIds: string[];
  label: string;
};

type Eligibility = Map<string, CandidatePerson[]>;

type SettingsPageProps = {
  searchParams?: { station?: string; error?: string; saved?: string; removed?: string };
};

function isMissingWorkflowSchema(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return message.includes("workforce_payout_dispute_workflows") && (
    message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find")
  );
}

function roleIdsFor(workflow: WorkflowRow | null): PayoutDisputeWorkflowSelection {
  return {
    initial: workflow?.initial_approver_role_ids ?? [],
    final: workflow?.final_approver_role_ids ?? [],
    processor: workflow?.processor_role_ids ?? []
  };
}

function stationLabel(station: StationRow) {
  return station.station_name && station.station_name !== station.station_code
    ? `${station.station_code} — ${station.station_name}`
    : station.station_code;
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return "Not saved";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(new Date(value));
}

async function loadEligibility(companyId: string, roleIds: string[], stations: StationRow[]): Promise<{ eligibility: Eligibility; error: string | null }> {
  const eligibility: Eligibility = new Map(roleIds.map((roleId) => [roleId, []]));
  if (!supabaseAdmin || !roleIds.length) return { eligibility, error: null };

  const [profilesResult, membershipsResult, positionsResult] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, full_name, email, role_id, location_scope_ids, is_active")
      .eq("company_id", companyId).eq("is_active", true),
    supabaseAdmin.from("company_product_memberships").select("user_id, role_id, has_all_location_access, location_scope_ids, is_active")
      .eq("company_id", companyId).eq("product_code", "operations").eq("is_active", true),
    supabaseAdmin.from("org_positions").select("id, role_id, location_access_mode, location_scope_ids, is_active")
      .eq("company_id", companyId).eq("is_active", true)
  ]);
  const firstError = profilesResult.error || membershipsResult.error || positionsResult.error;
  if (firstError) return { eligibility, error: firstError.message };

  const positions = positionsResult.data ?? [];
  const assignmentsResult = positions.length
    ? await supabaseAdmin.from("position_assignments")
      .select("position_id, profile_id, assignment_type, valid_from, valid_until, is_active, created_at")
      .eq("company_id", companyId).eq("is_active", true).in("position_id", positions.map((position) => position.id))
    : { data: [], error: null };
  if (assignmentsResult.error) return { eligibility, error: assignmentsResult.error.message };

  const stationCodeById = new Map(stations.map((station) => [station.id, station.station_code]));
  const profileById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const roleModeById = new Map<string, string>();
  const operationsMemberships = membershipsResult.data ?? [];
  const relevantRoleIds = Array.from(new Set([
    ...roleIds,
    ...operationsMemberships.map((membership) => membership.role_id).filter(Boolean),
    ...(profilesResult.data ?? []).map((profile) => profile.role_id).filter(Boolean),
    ...positions.map((position) => position.role_id).filter(Boolean)
  ]));
  const rolesResult = await supabaseAdmin.from("user_roles").select("id, location_access_mode")
    .eq("company_id", companyId).eq("is_active", true).in("id", relevantRoleIds);
  if (rolesResult.error) return { eligibility, error: rolesResult.error.message };
  for (const role of rolesResult.data ?? []) roleModeById.set(role.id, role.location_access_mode ?? "selected");

  function scopeLabel(allLocations: boolean, locationIds: string[] | null | undefined) {
    if (allLocations) return "All locations";
    const codes = (locationIds ?? []).map((id) => stationCodeById.get(id)).filter(Boolean) as string[];
    if (!codes.length) return "No active location scope";
    return codes.length <= 4 ? codes.join(", ") : `${codes.slice(0, 4).join(", ")} +${codes.length - 4}`;
  }

  function mergeScope(existing: CandidateScope | null, allLocations: boolean, locationIds: string[] | null | undefined): CandidateScope {
    const mergedAllLocations = Boolean(existing?.allLocations || allLocations);
    const mergedLocationIds = Array.from(new Set([...(existing?.locationIds ?? []), ...(locationIds ?? [])]));
    return {
      allLocations: mergedAllLocations,
      locationIds: mergedLocationIds,
      label: scopeLabel(mergedAllLocations, mergedLocationIds)
    };
  }

  function add(
    roleId: string | null | undefined,
    profileId: string,
    surface: "dashboardScope" | "opsScope",
    allLocations: boolean,
    locationIds: string[] | null | undefined
  ) {
    if (!roleId || !eligibility.has(roleId)) return;
    const profile = profileById.get(profileId);
    if (!profile?.is_active) return;
    const people = eligibility.get(roleId)!;
    const existing = people.find((person) => person.id === profileId);
    if (existing) {
      existing[surface] = mergeScope(existing[surface], allLocations, locationIds);
      return;
    }
    people.push({
      id: profileId,
      name: profile.full_name || profile.email || "Unnamed active user",
      email: profile.email,
      dashboardScope: surface === "dashboardScope" ? mergeScope(null, allLocations, locationIds) : null,
      opsScope: surface === "opsScope" ? mergeScope(null, allLocations, locationIds) : null
    });
  }

  const operationsMemberIds = new Set(operationsMemberships.map((membership) => membership.user_id));
  const membershipsByUser = new Map<string, typeof operationsMemberships>();
  for (const membership of operationsMemberships) {
    membershipsByUser.set(membership.user_id, [...(membershipsByUser.get(membership.user_id) ?? []), membership]);
  }
  for (const [profileId, memberships] of membershipsByUser) {
    const allLocations = memberships.some((membership) => (
      Boolean(membership.has_all_location_access) || roleModeById.get(membership.role_id) === "all_locations"
    ));
    const locationIds = Array.from(new Set(memberships.flatMap((membership) => membership.location_scope_ids ?? [])));
    for (const roleId of new Set(memberships.map((membership) => membership.role_id))) {
      add(roleId, profileId, "opsScope", allLocations, locationIds);
    }
  }

  const today = paymentRoutingDay();
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const activeAssignments = (assignmentsResult.data ?? [])
    .filter((assignment) => assignment.valid_from <= today && (!assignment.valid_until || assignment.valid_until >= today))
    .sort((left, right) => {
      if (left.assignment_type !== right.assignment_type) return left.assignment_type === "acting" ? -1 : 1;
      return String(right.created_at).localeCompare(String(left.created_at));
    });

  // Dashboard authorization unions the profile role and every active position
  // role, then unions their location scopes. Ops uses that same effective
  // access only when no Operations membership overrides it.
  const dashboardAccessByProfile = new Map<string, {
    allLocations: boolean;
    locationIds: Set<string>;
    roleIds: Set<string>;
  }>();
  for (const profile of profilesResult.data ?? []) {
    dashboardAccessByProfile.set(profile.id, {
      allLocations: Boolean(profile.role_id && roleModeById.get(profile.role_id) === "all_locations"),
      locationIds: new Set(profile.location_scope_ids ?? []),
      roleIds: new Set(profile.role_id ? [profile.role_id] : [])
    });
  }
  for (const assignment of activeAssignments) {
    const position = positionById.get(assignment.position_id);
    const access = dashboardAccessByProfile.get(assignment.profile_id);
    if (!position || !access) continue;
    access.roleIds.add(position.role_id);
    access.allLocations ||= position.location_access_mode === "all_locations"
      || roleModeById.get(position.role_id) === "all_locations";
    for (const locationId of position.location_scope_ids ?? []) access.locationIds.add(locationId);
  }
  for (const [profileId, access] of dashboardAccessByProfile) {
    const locationIds = [...access.locationIds];
    for (const roleId of access.roleIds) {
      add(roleId, profileId, "dashboardScope", access.allLocations, locationIds);
      if (!operationsMemberIds.has(profileId)) {
        add(roleId, profileId, "opsScope", access.allLocations, locationIds);
      }
    }
  }

  for (const people of eligibility.values()) people.sort((left, right) => left.name.localeCompare(right.name));
  return { eligibility, error: null };
}

function scopeCovers(scope: CandidateScope | null, stationId: string | null) {
  return Boolean(scope && (!stationId || scope.allLocations || scope.locationIds.includes(stationId)));
}

function peopleForStage({
  dashboardDisputeEditors,
  dashboardPayoutEditors,
  opsDisputeEditors,
  opsPayoutEditors,
  people,
  permissionsChecked,
  roleId,
  stage,
  stationId
}: {
  dashboardDisputeEditors: Set<string>;
  dashboardPayoutEditors: Set<string>;
  opsDisputeEditors: Set<string>;
  opsPayoutEditors: Set<string>;
  people: CandidatePerson[];
  permissionsChecked: boolean;
  roleId: string;
  stage: "initial" | "final" | "processor";
  stationId: string | null;
}) {
  const requiresPayout = stage === "processor";
  const dashboardReady = !permissionsChecked || (
    dashboardDisputeEditors.has(roleId) && (!requiresPayout || dashboardPayoutEditors.has(roleId))
  );
  const opsReady = !permissionsChecked || (
    opsDisputeEditors.has(roleId) && (!requiresPayout || opsPayoutEditors.has(roleId))
  );
  return people.flatMap((person) => {
    const dashboardScope = dashboardReady && scopeCovers(person.dashboardScope, stationId) ? person.dashboardScope : null;
    const opsScope = opsReady && scopeCovers(person.opsScope, stationId) ? person.opsScope : null;
    if (!dashboardScope && !opsScope) return [];
    const labels = [
      dashboardScope ? `Dashboard: ${dashboardScope.label}` : null,
      opsScope ? `Ops: ${opsScope.label}` : null
    ].filter(Boolean);
    return [{ ...person, scope: labels.join(" · ") }];
  });
}

function WorkflowForm({
  canEdit,
  dashboardDisputeEditors,
  dashboardPayoutEditors,
  eligibility,
  inherited,
  opsDisputeEditors,
  opsPayoutEditors,
  permissionsChecked,
  roles,
  station,
  workflow
}: {
  canEdit: boolean;
  dashboardDisputeEditors: Set<string>;
  dashboardPayoutEditors: Set<string>;
  eligibility: Eligibility;
  inherited: boolean;
  opsDisputeEditors: Set<string>;
  opsPayoutEditors: Set<string>;
  permissionsChecked: boolean;
  roles: RoleRow[];
  station: StationRow | null;
  workflow: WorkflowRow | null;
}) {
  const selection = roleIdsFor(workflow);
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const roleOptions = roles.map((role) => ({ value: role.id, label: role.name, helper: role.code }));
  const selectionError = workflow ? validateWorkflowSelection(selection) : null;
  const eligiblePeople = (roleId: string, stage: "initial" | "final" | "processor") => peopleForStage({
    dashboardDisputeEditors,
    dashboardPayoutEditors,
    opsDisputeEditors,
    opsPayoutEditors,
    people: eligibility.get(roleId) ?? [],
    permissionsChecked,
    roleId,
    stage,
    stationId: station?.id ?? null
  });
  const stagesByPerson = new Map<string, { name: string; stages: Set<string> }>();
  for (const stage of PAYOUT_DISPUTE_WORKFLOW_STAGES) {
    for (const roleId of selection[stage.code]) {
      for (const person of eligiblePeople(roleId, stage.code)) {
        const existing = stagesByPerson.get(person.id) ?? { name: person.name, stages: new Set<string>() };
        existing.stages.add(stage.label);
        stagesByPerson.set(person.id, existing);
      }
    }
  }
  const overlappingPeople = [...stagesByPerson.values()].filter((person) => person.stages.size > 1);

  return (
    <form action={savePayoutDisputeWorkflow} className="panel-body">
      <input name="station_id" type="hidden" value={station?.id ?? ""} />
      <input name="expected_version" type="hidden" value={inherited ? 0 : workflow?.version ?? 0} />
      {inherited ? (
        <div className="message-panel warn" style={{ marginBottom: 14 }}>
          <strong>This station currently inherits the company default.</strong>
          <p className="subtle" style={{ marginTop: 4 }}>The default roles are prefilled below. Saving creates a station-specific override.</p>
        </div>
      ) : null}
      {selectionError ? <div className="message-panel error" style={{ marginBottom: 14 }}><strong>Configuration needs attention</strong><p className="subtle" style={{ marginTop: 4 }}>{selectionError}</p></div> : null}
      {overlappingPeople.length ? (
        <div className="message-panel warn" style={{ marginBottom: 14 }}>
          <strong>Some active users qualify for more than one stage.</strong>
          <p className="subtle" style={{ marginTop: 4 }}>
            {overlappingPeople.slice(0, 5).map((person) => `${person.name} (${[...person.stages].join(" / ")})`).join(", ")}
            {overlappingPeople.length > 5 ? ` and ${overlappingPeople.length - 5} more` : ""}. Three different people are still enforced when acting; add fallbacks if needed.
          </p>
        </div>
      ) : null}

      {PAYOUT_DISPUTE_WORKFLOW_STAGES.map((stage) => {
        const selectedRoleIds = selection[stage.code];
        return (
          <div className="payment-approval-step-block" key={stage.code}>
            <div className="payment-approval-step-head">
              <div>
                <strong>{stage.label}</strong>
                <p className="subtle" style={{ marginTop: 4 }}>{stage.description}</p>
              </div>
              <span className="status-pill">Required</span>
            </div>
            <div className="form-grid three" style={{ padding: 0 }}>
              {Array.from({ length: PAYOUT_DISPUTE_WORKFLOW_MAX_CANDIDATES }, (_, index) => (
                <label key={index}>
                  {index === 0 ? "Primary role" : `Fallback role ${index}`}
                  <SearchableSelect
                    defaultValue={selectedRoleIds[index] ?? ""}
                    disabled={!canEdit}
                    name={`${stage.code}_role_id_${index}`}
                    options={roleOptions}
                    placeholder={index === 0 ? "Select required role" : "Optional fallback role"}
                    required={index === 0}
                  />
                </label>
              ))}
            </div>

            {selectedRoleIds.length ? (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead><tr><th>Priority</th><th>Role</th><th>Currently eligible active users</th><th>Permission check</th></tr></thead>
                  <tbody>
                    {selectedRoleIds.map((roleId, index) => {
                      const role = roleById.get(roleId);
                      const people = eligiblePeople(roleId, stage.code);
                      const warnings: string[] = [];
                      const dashboardReady = dashboardDisputeEditors.has(roleId) && (
                        stage.code !== "processor" || dashboardPayoutEditors.has(roleId)
                      );
                      const opsReady = opsDisputeEditors.has(roleId) && (
                        stage.code !== "processor" || opsPayoutEditors.has(roleId)
                      );
                      if (permissionsChecked && !dashboardReady && !opsReady) {
                        warnings.push(stage.code === "processor"
                          ? "Needs matching Disputes + Workforce Payouts edit on Dashboard or Ops"
                          : "Needs Disputes edit on Dashboard or Ops");
                      }
                      return (
                        <tr key={`${stage.code}-${roleId}`}>
                          <td>{index === 0 ? "Primary" : `Fallback ${index}`}</td>
                          <td><strong>{role?.name ?? "Inactive or missing role"}</strong><br /><span className="subtle">{role?.code ?? roleId}</span></td>
                          <td>
                            {people.length ? people.slice(0, 4).map((person) => (
                              <div key={person.id}><strong>{person.name}</strong><span className="subtle"> · {person.scope}</span></div>
                            )) : <span className="status-pill warn">No eligible active user</span>}
                            {people.length > 4 ? <div className="subtle">+{people.length - 4} more</div> : null}
                          </td>
                          <td>{warnings.length ? warnings.map((warning) => <div className="status-pill warn" key={warning} style={{ marginBottom: 4 }}>{warning}</div>) : <span className="status-pill good">Ready</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="subtle" style={{ marginTop: 12 }}>Select roles and save to activate this stage.</p>}
          </div>
        );
      })}

      <div className="form-actions" style={{ justifyContent: "space-between" }}>
        <span className="subtle">
          {workflow?.updated_at ? `Version ${workflow.version} · updated ${formatUpdatedAt(workflow.updated_at)}` : "Not saved yet"}
        </span>
        {canEdit ? <SubmitButton className="button primary">{station ? "Save station override" : "Save company default"}</SubmitButton> : null}
      </div>
    </form>
  );
}

export const dynamic = "force-dynamic";

export default async function PayoutDisputeWorkflowSettingsPage({ searchParams }: SettingsPageProps) {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, "payment_settings", "edit");
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  const isOpsHost = host === "ops.dropxlogistics.com" || host.startsWith("ops-");
  const backHref = isFinanceHostName(host) ? "/settings/payments" : isOpsHost ? "/" : "/settings/workforce-payment";
  const backLabel = isOpsHost ? "Back to OpsPulse" : "Back to payment settings";

  if (!supabaseAdmin) {
    return (
      <AppShell active="Payout Dispute Workflow" pageCode="payment_settings">
        <PageHead eyebrow="Configuration" title="Payout Dispute Workflow" subtitle="Configure independent initial approval, final approval and payout processing roles." />
        <section className="panel message-panel error"><div className="panel-body"><strong>Database connection is not configured.</strong></div></section>
      </AppShell>
    );
  }

  const [rolesResult, stationsResult, workflowsResult] = await Promise.all([
    supabaseAdmin.from("user_roles").select("id, code, name, is_active, location_access_mode")
      .eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("stations").select("id, station_code, station_name, is_active")
      .eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("workforce_payout_dispute_workflows")
      .select("id, station_id, initial_approver_role_ids, final_approver_role_ids, processor_role_ids, is_active, version, updated_at")
      .eq("company_id", companyId).eq("is_active", true).order("updated_at", { ascending: false })
  ]);
  const schemaMissing = Boolean(workflowsResult.error && isMissingWorkflowSchema(workflowsResult.error));
  const dataError = rolesResult.error?.message || stationsResult.error?.message || (!schemaMissing ? workflowsResult.error?.message : null);
  const roles = (rolesResult.data ?? []) as RoleRow[];
  const stations = (stationsResult.data ?? []) as StationRow[];
  const workflows = schemaMissing ? [] : (workflowsResult.data ?? []) as WorkflowRow[];
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const defaultWorkflow = workflows.find((workflow) => !workflow.station_id) ?? null;
  const overrides = workflows.filter((workflow) => workflow.station_id && stationById.has(workflow.station_id));
  const selectedStation = searchParams?.station ? stationById.get(searchParams.station) ?? null : null;
  const selectedOverride = selectedStation ? overrides.find((workflow) => workflow.station_id === selectedStation.id) ?? null : null;
  const editedWorkflow = selectedStation ? selectedOverride ?? defaultWorkflow : defaultWorkflow;
  const inherited = Boolean(selectedStation && !selectedOverride && defaultWorkflow);

  const configuredRoleIds = Array.from(new Set(workflows.flatMap((workflow) => [
    ...(workflow.initial_approver_role_ids ?? []),
    ...(workflow.final_approver_role_ids ?? []),
    ...(workflow.processor_role_ids ?? [])
  ])));
  const { eligibility, error: eligibilityError } = await loadEligibility(companyId, configuredRoleIds, stations);

  let dashboardDisputeEditors = new Set<string>();
  let opsDisputeEditors = new Set<string>();
  let dashboardPayoutEditors = new Set<string>();
  let opsPayoutEditors = new Set<string>();
  let permissionError: string | null = null;
  if (configuredRoleIds.length) {
    try {
      [dashboardDisputeEditors, opsDisputeEditors, dashboardPayoutEditors, opsPayoutEditors] = await Promise.all([
        roleIdsWithPageEditAccess(companyId, configuredRoleIds, "workforce_payout_disputes", true),
        roleIdsWithPageEditAccess(companyId, configuredRoleIds, "ops_workforce_payout_disputes", true),
        roleIdsWithPageEditAccess(companyId, configuredRoleIds, "workforce_payouts", true),
        roleIdsWithPageEditAccess(companyId, configuredRoleIds, "ops_workforce_payouts", true)
      ]);
    } catch (error) {
      permissionError = error instanceof Error ? error.message : "Role permissions could not be checked.";
    }
  }
  return (
    <AppShell active="Payout Dispute Workflow" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Payout Dispute Workflow"
        subtitle="Set independent role fallbacks for initial approval, final approval and payout correction processing. No SLA is applied."
        action={<PendingLink className="button secondary" href={backHref}>{backLabel}</PendingLink>}
      />

      {schemaMissing ? (
        <section className="panel message-panel error"><div className="panel-body">
          <strong>Workflow database setup is pending</strong>
          <p className="subtle" style={{ marginTop: 6 }}>Apply the payout dispute processing migration, then refresh this page. Existing disputes are unchanged.</p>
        </div></section>
      ) : null}
      {dataError || eligibilityError || permissionError ? (
        <section className="panel message-panel error"><div className="panel-body">
          <strong>Some setup checks could not be loaded</strong>
          <p className="subtle" style={{ marginTop: 6 }}>{dataError ?? eligibilityError ?? permissionError}</p>
        </div></section>
      ) : null}
      {searchParams?.error || searchParams?.saved || searchParams?.removed ? (
        <section className={`panel message-panel ${searchParams.error ? "error" : "success"}`}><div className="panel-body">
          <strong>{searchParams.error ? "Action required" : "Completed"}</strong>
          <p className="subtle" style={{ marginTop: 6 }}>{searchParams.error ?? (searchParams.removed ? "Station override removed. The company default now applies." : "Payout dispute workflow saved.")}</p>
        </div></section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Routing rules</h2>
            <p className="subtle">The first eligible role is used. A fallback is tried only when no active, permitted user in the earlier role covers the dispute station.</p>
          </div>
          <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>
        </div>
        <div className="panel-body form-grid three">
          <div><span className="subtle">Initial decision</span><h3>Initial approver</h3><p className="subtle">Proposes correction or rejection.</p></div>
          <div><span className="subtle">Independent check</span><h3>Final approver</h3><p className="subtle">Cannot be the initial role.</p></div>
          <div><span className="subtle">Approved correction</span><h3>Processor</h3><p className="subtle">Needs Workforce Payouts edit access.</p></div>
        </div>
      </section>

      {!schemaMissing ? <>
        <section className="panel">
          <div className="panel-head"><div>
            <h2>Company default</h2>
            <p className="subtle">Used for every dispute station that does not have an active override. Eligible people are filtered to the dispute station at runtime.</p>
          </div></div>
          <WorkflowForm
            canEdit={canEdit}
            dashboardDisputeEditors={dashboardDisputeEditors}
            dashboardPayoutEditors={dashboardPayoutEditors}
            eligibility={eligibility}
            inherited={false}
            opsDisputeEditors={opsDisputeEditors}
            opsPayoutEditors={opsPayoutEditors}
            permissionsChecked={!permissionError}
            roles={roles}
            station={null}
            workflow={defaultWorkflow}
          />
        </section>

        <section className="panel">
          <div className="panel-head"><div>
            <h2>Station overrides</h2>
            <p className="subtle">Add an override only when a station needs different roles. Removing it restores the company default.</p>
          </div></div>
          <form className="panel-body form-grid two" method="get">
            <label>Station
              <select className="select" defaultValue={selectedStation?.id ?? ""} name="station" required>
                <option disabled value="">Select a station</option>
                {stations.map((station) => <option key={station.id} value={station.id}>{stationLabel(station)}</option>)}
              </select>
            </label>
            <div className="form-actions align-right"><button className="button secondary" type="submit">Configure override</button></div>
          </form>

          {overrides.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Station</th><th>Initial approval</th><th>Final approval</th><th>Processor</th><th /></tr></thead>
                <tbody>
                  {overrides.map((workflow) => {
                    const station = stationById.get(workflow.station_id!);
                    const roleNames = (roleIds: string[] | null) => (roleIds ?? []).map((id) => roles.find((role) => role.id === id)?.name ?? "Missing role").join(" → ");
                    return (
                      <tr key={workflow.id}>
                        <td><strong>{station ? stationLabel(station) : workflow.station_id}</strong></td>
                        <td>{roleNames(workflow.initial_approver_role_ids)}</td>
                        <td>{roleNames(workflow.final_approver_role_ids)}</td>
                        <td>{roleNames(workflow.processor_role_ids)}</td>
                        <td><PendingLink className="button secondary compact" href={`${PAGE_PATH}?station=${encodeURIComponent(workflow.station_id!)}`}>Configure</PendingLink></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="panel-body"><p className="subtle">No station overrides. The company default applies everywhere.</p></div>}
        </section>

        {selectedStation ? (
          <section className="panel" id="station-override">
            <div className="panel-head">
              <div><h2>{stationLabel(selectedStation)}</h2><p className="subtle">Preview is filtered to active users whose current location access covers this station.</p></div>
              <PendingLink className="button secondary compact" href={PAGE_PATH}>Close</PendingLink>
            </div>
            <WorkflowForm
              canEdit={canEdit}
              dashboardDisputeEditors={dashboardDisputeEditors}
              dashboardPayoutEditors={dashboardPayoutEditors}
              eligibility={eligibility}
              inherited={inherited}
              opsDisputeEditors={opsDisputeEditors}
              opsPayoutEditors={opsPayoutEditors}
              permissionsChecked={!permissionError}
              roles={roles}
              station={selectedStation}
              workflow={editedWorkflow}
            />
            {selectedOverride && canEdit ? (
              <form action={removePayoutDisputeWorkflowOverride} className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
                <input name="station_id" type="hidden" value={selectedStation.id} />
                <input name="expected_version" type="hidden" value={selectedOverride.version} />
                <div className="form-actions" style={{ justifyContent: "space-between" }}>
                  <span className="subtle">Removing this override immediately restores the company default for new routing.</span>
                  <SubmitButton
                    className="button secondary"
                    confirmDescription="Existing dispute snapshots remain unchanged. New routing will use the company default."
                    confirmMessage={`Remove the payout dispute workflow override for ${stationLabel(selectedStation)}?`}
                    confirmSubmitText="Remove override"
                    confirmTitle="Remove station override"
                  >Remove override</SubmitButton>
                </div>
              </form>
            ) : null}
          </section>
        ) : null}
      </> : null}
    </AppShell>
  );
}

const PAGE_PATH = "/settings/payout-disputes";


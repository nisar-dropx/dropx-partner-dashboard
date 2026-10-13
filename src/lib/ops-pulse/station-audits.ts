import { allAuditRows, auditRowsForIds } from "@/lib/ops-pulse/station-audit-query";
import "server-only";
import { loadAuditAssignees, type AuditAssignee } from "./station-audit-people";

import {
  auditCycle,
  auditTimestamp,
  stationCanSeeAudit,
} from "./station-audit-planning";
import { randomUUID } from "node:crypto";
import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

import type { AuditScoreSnapshot } from "./station-audit-scoring";

export type AuditType = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  cadence_unit: string;
  required_count: number;
  scheduling_config: Record<string, unknown>;
  default_response_hours: number;
  expected_duration_minutes: number | null;
  requires_video_link: boolean;
  shipment_reconciliation_enabled?: boolean;
  scoring_enabled?: boolean;
  video_link_help: string | null;
  email_subject_template: string | null;
  email_body_template: string | null;
  recipient_rules: string[];
  cc_rules: string[];
  is_active: boolean;
  sort_order: number;
};

export type AuditSection = {
  score_weight?: number;
  id: string;
  audit_type_id: string;
  code: string;
  name: string;
  guidance: string | null;
  sort_order: number;
  is_active: boolean;
};
export type AuditChecklistItem = {
  score_weight?: number;
  score_source?: string;
  id: string;
  audit_type_id: string;
  section_id: string | null;
  code: string;
  label: string;
  guidance: string | null;
  response_type: string;
  response_options: Array<{
    value: string;
    label: string;
    is_compliant: boolean | null;
    requires_action: boolean;
    requires_evidence: boolean;
    score?: number | null;
  }>;
  is_required: boolean;
  evidence_rule: string;
  photo_required?: boolean;
  photo_on_non_compliance?: boolean;
  remarks_required?: boolean;
  employee_selection?: "none" | "single" | "multiple";
  action_rule: string;
  default_severity_code: string | null;
  sort_order: number;
  is_active: boolean;
};
export type AuditOption = {
  id: string;
  option_group: string;
  code: string;
  label: string;
  description: string | null;
  metadata: Record<string, unknown>;
  sort_order: number;
  is_active: boolean;
};
export type AuditStation = {
  id: string;
  station_code: string;
  station_name: string | null;
  city: string | null;
  cluster: string | null;
  cluster_name: string | null;
  region: string | null;
  station_email: string | null;
  station_manager_email: string | null;
  cluster_manager_email: string | null;
  ops_manager_email: string | null;
  finance_manager_email: string | null;
  location_model_id: string | null;
  is_ho: boolean;
};
export type AuditProgrammeSettings = {
  company_id: string;
  delete_user_ids: string[];
  scheduler_role_ids: string[];
  responder_role_ids: string[];
  excluded_location_model_ids: string[];
  excluded_location_ids: string[];
  exclude_head_office: boolean;
  /** Roles that create or assign audits at any station and approve cross-station requests. */
  cross_audit_role_ids: string[];
  /** False until the cross-station database update has been applied. */
  cross_audit_ready: boolean;
};
export type AuditRole = {
  id: string;
  code: string;
  name: string;
  product_code: string | null;
};
export type AuditLocationModel = { id: string; code: string; name: string };
export type StationAudit = {
  id: string;
  audit_number: string;
  audit_type_id: string;
  location_id: string;
  cycle_key: string;
  period_slot: string;
  scheduled_for: string;
  scheduled_reason: string | null;
  schedule_source: string;
  /** The auditor is outside this station's scope and reaches only this audit. */
  cross_station?: boolean;
  status_code: string;
  assigned_to: string | null;
  assignment_verified: boolean;
  deleted_at: string | null;
  updated_at: string;
  cash_variance_reason: string | null;
  email_sent_at: string | null;
  email_error: string | null;
  email_recipients: string[];
  assigned_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  scheduled_by: string | null;
  response_due_at: string | null;
  station_response_status: string;
  system_cash_amount: number | null;
  physical_cash_amount: number | null;
  cash_variance_amount: number | null;
  system_shipment_count: number | null;
  physical_shipment_count: number | null;
  shipment_missing_count: number;
  shipment_excess_count: number;
  shipment_unresolved_count: number;
  video_call_url: string | null;
  overall_summary: string | null;
  station_summary: string | null;
  manager_summary: string | null;
  score: number | null;
  score_snapshot?: AuditScoreSnapshot | null;
  email_status: string;
  ops_audit_types?: Pick<
    AuditType,
    | "code"
    | "name"
    | "requires_video_link"
    | "default_response_hours"
    | "video_link_help"
  > | null;
  stations?: Pick<
    AuditStation,
    "station_code" | "station_name" | "city" | "cluster" | "cluster_name"
  > | null;
};

type AuditAction = {
  id: string;
  audit_id: string;
  title: string;
  corrective_action: string;
  preventive_action: string | null;
  severity_code: string | null;
  status_code: string;
  owner_name: string | null;
  owner_email: string | null;
  due_at: string | null;
  completion_note: string | null;
};
type AuditComment = {
  id: string;
  audit_id: string;
  body: string;
  audience: string;
  requests_station_response: boolean;
  author_name: string | null;
  author_email: string | null;
  created_at: string;
};
type AuditEvidence = {
  id: string;
  audit_id: string;
  file_name: string | null;
  media_url: string;
  caption: string | null;
  evidence_kind_code: string | null;
  checklist_item_id?: string | null;
  content_type?: string | null;
  uploaded_at: string;
};
type AuditResponse = {
  id: string;
  audit_id: string;
  checklist_item_id: string;
  response_value: unknown;
  is_compliant: boolean | null;
  remarks: string | null;
};
type CashCount = {
  id: string;
  audit_id: string;
  cash_side: string;
  denomination_option_id: string | null;
  denomination_value: number;
  note_count: number;
  computed_amount: number;
  notes: string | null;
};
type AuditShipment = {
  id: string;
  audit_id: string;
  tracking_id: string;
  system_status_code: string | null;
  physical_status_code: string | null;
  discrepancy_code: string | null;
  remarks: string | null;
  required_action: string | null;
  due_at: string | null;
  is_resolved: boolean;
  station_response?: {
    status: string;
    label: string;
    remarks: string;
    employee: import("./station-audit-reconciliation").AuditEmployee | null;
    responded_by: string;
    responded_name: string;
    responded_at: string;
  } | null;
};

export type AuditEvent = {
  id: string;
  audit_id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  created_at: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
};

export type AuditRequest = {
  id: string;
  location_id: string;
  audit_type_id: string;
  requested_by: string;
  requested_name: string | null;
  preferred_date: string | null;
  reason: string;
  status: string;
  decided_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  audit_id: string | null;
  created_at: string;
  station_code: string;
  station_name: string | null;
  /** The viewer may approve or decline this request. */
  canDecide: boolean;
};
export type StationAuditWorkspace = {
  /** Stations outside the viewer's scope that hold an audit assigned to them. */
  crossStations: AuditStation[];
  requests: AuditRequest[];
  /** The viewer creates and assigns audits at any eligible station. */
  anyStation: boolean;
  assignees: AuditAssignee[];
  events: AuditEvent[];
  truncated: boolean;
  auditTypes: AuditType[];
  sections: AuditSection[];
  checklistItems: AuditChecklistItem[];
  options: AuditOption[];
  stations: AuditStation[];
  audits: StationAudit[];
  actions: AuditAction[];
  comments: AuditComment[];
  evidence: AuditEvidence[];
  responses: AuditResponse[];
  cashCounts: CashCount[];
  shipments: AuditShipment[];
  programmeSettings: AuditProgrammeSettings;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

export function canUseStationAuditLocation(
  authorization: Pick<
    AuthorizationContext,
    "hasAllLocationAccess" | "locationScopeIds"
  >,
  locationId: string,
) {
  return (
    authorization.hasAllLocationAccess ||
    authorization.locationScopeIds.includes(locationId)
  );
}

export function canAssignAnyStation(
  authorization: Pick<AuthorizationContext, "isMasterOwner" | "effectiveRoleIds">,
  settings: Pick<AuditProgrammeSettings, "cross_audit_role_ids">,
) {
  return (
    authorization.isMasterOwner ||
    authorization.effectiveRoleIds.some((roleId) =>
      settings.cross_audit_role_ids.includes(roleId),
    )
  );
}

/**
 * The viewer's reach inside station audits. Cross-audit managers act on every
 * eligible station here; their access to other pages is unchanged.
 */
export function stationAuditScope<T extends AuthorizationContext>(
  authorization: T,
  settings: AuditProgrammeSettings,
): T {
  return canManageStationAudits(authorization, settings) &&
    canAssignAnyStation(authorization, settings) &&
    !authorization.hasAllLocationAccess
    ? { ...authorization, hasAllLocationAccess: true }
    : authorization;
}

/** In scope, or the one audit a cross-station auditor has been assigned. */
export function canUseStationAudit(
  authorization: Pick<
    AuthorizationContext,
    "hasAllLocationAccess" | "locationScopeIds" | "userId"
  >,
  audit: {
    location_id: string;
    assigned_to?: string | null;
    assignment_verified?: boolean | null;
    cross_station?: boolean | null;
  },
) {
  return (
    canUseStationAuditLocation(authorization, audit.location_id) ||
    (audit.cross_station === true &&
      audit.assignment_verified === true &&
      Boolean(authorization.userId) &&
      audit.assigned_to === authorization.userId)
  );
}

/** A missing table, column or function means the database update is still pending. */
export function isAuditSchemaPending(error: { code?: string; message?: string } | null) {
  return Boolean(
    error &&
      (["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(
        error.code ?? "",
      ) ||
        /could not find the (function|table)|does not exist|schema cache/i.test(
          error.message ?? "",
        )),
  );
}
export const auditSchemaPendingMessage =
  "This needs a database update that has not been applied yet. Ask the technical team to apply the latest station audit migration.";

/**
 * Whether the viewer may open this audit. The cross-station assignment is looked
 * up only when the station is outside their scope, so in-scope requests cost nothing.
 */
export async function canOpenStationAudit(
  companyId: string,
  authorization: AuthorizationContext,
  settings: AuditProgrammeSettings,
  audit: { id: string; location_id: string },
) {
  const scope = stationAuditScope(authorization, settings);
  if (canUseStationAuditLocation(scope, audit.location_id)) return true;
  if (!scope.userId) return false;
  const row = await db()
    .from("ops_station_audits")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", audit.id)
    .is("deleted_at", null)
    .maybeSingle();
  return Boolean(row.data && canUseStationAudit(scope, row.data));
}

export function canManageStationAudits(
  authorization: AuthorizationContext,
  settings: AuditProgrammeSettings,
) {
  return (
    authorization.isMasterOwner ||
    authorization.effectiveRoleIds.some((roleId) =>
      settings.scheduler_role_ids.includes(roleId),
    )
  );
}

export function canRespondToStationAudits(
  authorization: AuthorizationContext,
  settings: AuditProgrammeSettings,
) {
  const permission = authorization.permissions.station_audits;
  return Boolean(
    !authorization.readOnly &&
      (permission?.canAdd || permission?.canEdit) &&
      authorization.effectiveRoleIds.some((roleId) =>
        settings.responder_role_ids.includes(roleId),
      ),
  );
}

export function isStationAuditEligible(
  station: Pick<AuditStation, "id" | "location_model_id" | "is_ho">,
  settings: AuditProgrammeSettings,
) {
  return (
    !settings.excluded_location_ids.includes(station.id) &&
    !settings.excluded_location_model_ids.includes(
      station.location_model_id ?? "",
    ) &&
    !(settings.exclude_head_office && station.is_ho)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function responseOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = record(item);
      const option = String(row.value ?? "").trim();
      return option
        ? {
            value: option,
            label: String(row.label ?? option).trim() || option,
            is_compliant:
              typeof row.is_compliant === "boolean" ? row.is_compliant : null,
            requires_action: row.requires_action === true,
            requires_evidence: row.requires_evidence === true,
            score: typeof row.score === "number" ? row.score : null,
          }
        : null;
    })
    .filter(
      (
        item,
      ): item is {
        value: string;
        label: string;
        is_compliant: boolean | null;
        requires_action: boolean;
        requires_evidence: boolean;
        score: number | null;
      } => Boolean(item),
    );
}

function mapType(row: any): AuditType {
  return {
    ...row,
    scheduling_config: record(row.scheduling_config),
    recipient_rules: stringList(row.recipient_rules),
    cc_rules: stringList(row.cc_rules),
  } as AuditType;
}
function mapItem(row: any): AuditChecklistItem {
  return {
    ...row,
    response_options: responseOptions(row.response_options),
  } as AuditChecklistItem;
}
function mapOption(row: any): AuditOption {
  return { ...row, metadata: record(row.metadata) } as AuditOption;
}

export async function loadStationAuditMaster(companyId: string) {
  const [types, sections, items, options, programmeSettings] =
    await Promise.all([
      db()
        .from("ops_audit_types")
        .select("*")
        .eq("company_id", companyId)
        .order("sort_order")
        .order("name"),
      db()
        .from("ops_audit_checklist_sections")
        .select("*")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("sort_order")
        .order("name"),
      db()
        .from("ops_audit_checklist_items")
        .select("*")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("sort_order")
        .order("label"),
      db()
        .from("ops_audit_reference_options")
        .select("*")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("option_group")
        .order("sort_order")
        .order("label"),
      db()
        .from("ops_audit_programme_settings")
        // Every column, so a setting added by a later database update is optional.
        .select("*")
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);
  const error =
    types.error ||
    sections.error ||
    items.error ||
    options.error ||
    programmeSettings.error;
  if (error) throw new Error(error.message);
  return {
    auditTypes: (types.data ?? []).map(mapType),
    sections: (sections.data ?? []) as AuditSection[],
    checklistItems: (items.data ?? []).map(mapItem),
    options: (options.data ?? []).map(mapOption),
    programmeSettings: {
      company_id: companyId,
      delete_user_ids: stringList(programmeSettings.data?.delete_user_ids),
      scheduler_role_ids: stringList(
        programmeSettings.data?.scheduler_role_ids,
      ),
      responder_role_ids: stringList(
        programmeSettings.data?.responder_role_ids,
      ),
      excluded_location_model_ids: stringList(
        programmeSettings.data?.excluded_location_model_ids,
      ),
      excluded_location_ids: stringList(
        programmeSettings.data?.excluded_location_ids,
      ),
      exclude_head_office: programmeSettings.data?.exclude_head_office === true,
      cross_audit_role_ids: stringList(
        programmeSettings.data?.cross_audit_role_ids,
      ),
      cross_audit_ready: Boolean(
        programmeSettings.data &&
          "cross_audit_role_ids" in programmeSettings.data,
      ),
    } satisfies AuditProgrammeSettings,
  };
}

export async function loadAuditMasterConfiguration(companyId: string) {
  const [master, roles, locationModels, stations] = await Promise.all([
    loadStationAuditMaster(companyId),
    db()
      .from("user_roles")
      .select("id,code,name,product_code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .or("product_code.eq.operations,code.eq.LOCATION")
      .order("product_code")
      .order("name"),
    db()
      .from("location_models")
      .select("id,code,name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    db()
      .from("stations")
      .select("id,station_code,station_name,city,location_model_id,is_ho")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("hide_from_location_list", false)
      .order("station_code"),
  ]);
  const error = roles.error || locationModels.error || stations.error;
  if (error) throw new Error(error.message);
  return {
    ...master,
    roles: (roles.data ?? []) as AuditRole[],
    locationModels: (locationModels.data ?? []) as AuditLocationModel[],
    allStations: (stations.data ?? []) as Array<
      Pick<
        AuditStation,
        | "id"
        | "station_code"
        | "station_name"
        | "city"
        | "location_model_id"
        | "is_ho"
      >
    >,
  };
}

export async function loadAuditStations(
  companyId: string,
  authorization: Pick<
    AuthorizationContext,
    "hasAllLocationAccess" | "locationScopeIds"
  >,
  settings: AuditProgrammeSettings,
) {
  let query = db()
    .from("stations")
    .select(stationColumns)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("hide_from_location_list", false)
    .order("station_code");
  if (!authorization.hasAllLocationAccess) {
    if (!authorization.locationScopeIds.length) return [] as AuditStation[];
    query = query.in("id", authorization.locationScopeIds);
  }
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as AuditStation[]).filter((station) =>
    isStationAuditEligible(station, settings),
  );
}

const stationColumns =
  "id,station_code,station_name,city,cluster,cluster_name,region,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email,location_model_id,is_ho";
const auditColumns =
  "*,ops_audit_types(code,name,requires_video_link,default_response_hours,video_link_help),stations(station_code,station_name,city,cluster,cluster_name)";

/** Active users who report to this person. Empty when the reporting line is not recorded. */
export async function loadAuditReportees(companyId: string, userId: string) {
  const result = await db()
    .from("profiles")
    .select("id")
    .eq("company_id", companyId)
    .eq("reports_to_user_id", userId)
    .eq("is_active", true);
  return result.error ? [] : (result.data ?? []).map((row) => String(row.id));
}

/**
 * Cross-station requests the viewer raised or may decide: open ones, and those
 * decided in the last 30 days. Empty until the database update is applied.
 */
export async function loadAuditRequests(
  companyId: string,
  authorization: Pick<AuthorizationContext, "userId">,
  anyStation: boolean,
): Promise<AuditRequest[]> {
  const reportees = anyStation
    ? []
    : await loadAuditReportees(companyId, authorization.userId);
  let query = db()
    .from("ops_station_audit_requests")
    .select(
      "id,location_id,audit_type_id,requested_by,requested_name,preferred_date,reason,status,decided_name,decided_at,decision_note,audit_id,created_at,stations(station_code,station_name)",
    )
    .eq("company_id", companyId)
    .or(
      `status.eq.pending,created_at.gte.${new Date(Date.now() - 30 * 86400000).toISOString()}`,
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (!anyStation)
    query = query.in("requested_by", [authorization.userId, ...reportees]);
  const result = await query;
  if (result.error) {
    if (isAuditSchemaPending(result.error)) return [];
    throw new Error(result.error.message);
  }
  return (result.data ?? []).map((row: any) => {
    const station = Array.isArray(row.stations) ? row.stations[0] : row.stations;
    return {
      id: row.id,
      location_id: row.location_id,
      audit_type_id: row.audit_type_id,
      requested_by: row.requested_by,
      requested_name: row.requested_name,
      preferred_date: row.preferred_date,
      reason: row.reason,
      status: row.status,
      decided_name: row.decided_name,
      decided_at: row.decided_at,
      decision_note: row.decision_note,
      audit_id: row.audit_id,
      created_at: row.created_at,
      station_code: String(station?.station_code ?? ""),
      station_name: station?.station_name ?? null,
      canDecide:
        row.status === "pending" &&
        row.requested_by !== authorization.userId &&
        (anyStation || reportees.includes(row.requested_by)),
    } satisfies AuditRequest;
  });
}

export async function loadStationAuditWorkspace(
  companyId: string,
  authorization: AuthorizationContext,
  from: string,
  to: string,
  stationOnly = false,
  existingMaster?: Awaited<ReturnType<typeof loadStationAuditMaster>>,
): Promise<StationAuditWorkspace> {
  const master = existingMaster ?? (await loadStationAuditMaster(companyId));
  stationOnly =
    stationOnly ||
    !canManageStationAudits(authorization, master.programmeSettings);
  const stations = await loadAuditStations(
    companyId,
    authorization,
    master.programmeSettings,
  );
  const stationIds = stations.map((station) => station.id);
  const assignees =
    !stationOnly && stationIds.length
      ? await loadAuditAssignees(
          companyId,
          master.programmeSettings.scheduler_role_ids,
          stationIds,
        )
      : [];
  const anyStation =
    !stationOnly && canAssignAnyStation(authorization, master.programmeSettings);
  const requests = stationOnly
    ? []
    : await loadAuditRequests(companyId, authorization, anyStation);
  // Audits this person performs at a station outside their own scope.
  const crossResult = stationOnly
    ? { data: [], error: null }
    : await db()
        .from("ops_station_audits")
        .select(auditColumns)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .eq("cross_station", true)
        .eq("assigned_to", authorization.userId)
        .eq("assignment_verified", true)
        .neq("status_code", "closed")
        .order("scheduled_for", { ascending: true })
        .limit(200);
  if (crossResult.error && !isAuditSchemaPending(crossResult.error))
    throw new Error(crossResult.error.message);
  const crossAudits = ((crossResult.data ?? []) as StationAudit[]).filter(
    (audit) => !stationIds.includes(audit.location_id),
  );
  const crossStationIds = [...new Set(crossAudits.map((a) => a.location_id))];
  const crossStationsResult = crossStationIds.length
    ? await db()
        .from("stations")
        .select(stationColumns)
        .eq("company_id", companyId)
        .in("id", crossStationIds)
    : { data: [], error: null };
  if (crossStationsResult.error)
    throw new Error(crossStationsResult.error.message);
  const crossStations = (crossStationsResult.data ?? []) as AuditStation[];
  const base = { ...master, assignees, stations, crossStations, requests, anyStation };
  if (!stationIds.length && !crossAudits.length)
    return {
      ...base,
      events: [],
      truncated: false,
      audits: [],
      actions: [],
      comments: [],
      evidence: [],
      responses: [],
      cashCounts: [],
      shipments: [],
    };
  let auditsQuery = db()
    .from("ops_station_audits")
    .select(auditColumns)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .in("location_id", stationIds);
  auditsQuery = stationOnly
    ? auditsQuery
        .not("completed_at", "is", null)
        .in("status_code", [
          "awaiting_station_response",
          "under_review",
          "closed",
        ])
    : auditsQuery.or(
        `and(scheduled_for.gte.${from}T00:00:00+05:30,scheduled_for.lte.${to}T23:59:59.999+05:30),and(assigned_to.eq.${authorization.userId},assignment_verified.eq.true,status_code.neq.closed)`,
      );
  const auditsResult = stationIds.length
    ? await allAuditRows((start, end) => auditsQuery
        .order("scheduled_for", { ascending: true }).order("id")
        .range(start, end))
    : { data: [], error: null };
  if (auditsResult.error) throw new Error(auditsResult.error.message);
  const audits = [...((auditsResult.data ?? []) as StationAudit[]), ...crossAudits]
    .filter((audit) => !stationOnly || stationCanSeeAudit(audit))
    .map((audit) =>
      stationOnly ? { ...audit, manager_summary: null } : audit,
    );
  const auditIds = audits.map((audit) => audit.id);
  if (!auditIds.length)
    return {
      ...base,
      events: [],
      truncated: false,
      audits,
      actions: [],
      comments: [],
      evidence: [],
      responses: [],
      cashCounts: [],
      shipments: [],
    };
  const [
    actions,
    comments,
    evidence,
    responses,
    cashCounts,
    shipments,
    events,
  ] = await Promise.all([
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_actions")
        .select(
          "id,audit_id,title,corrective_action,preventive_action,severity_code,status_code,owner_name,owner_email,due_at,completion_note",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("due_at", { ascending: true })
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_comments")
        .select(
          "id,audit_id,body,audience,requests_station_response,author_name,author_email,created_at",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("created_at", { ascending: true })
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_evidence")
        .select(
          "id,audit_id,file_name,media_url,caption,evidence_kind_code,checklist_item_id,content_type,uploaded_at",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("uploaded_at", { ascending: false })
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_check_responses")
        .select(
          "id,audit_id,checklist_item_id,response_value,is_compliant,remarks",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_cash_counts")
        .select(
          "id,audit_id,cash_side,denomination_option_id,denomination_value,note_count,computed_amount,notes",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("denomination_value", { ascending: false })
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_shipments")
        .select(
          "id,audit_id,tracking_id,system_status_code,physical_status_code,discrepancy_code,remarks,required_action,due_at,is_resolved,station_response",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
    auditRowsForIds(auditIds, (batchIds, from, to) =>
      db()
        .from("ops_station_audit_events")
        .select(
          "id,audit_id,event_type,actor_user_id,actor_name,actor_email,created_at,before_data,after_data",
        )
        .eq("company_id", companyId)
        .in("audit_id", batchIds)
        .in(
          "event_type",
          stationOnly
            ? ["submitted", "amended", "closed", "station_responded"]
            : [
                "scheduled",
                "rescheduled",
                "reassigned",
                "email_sent",
                "email_failed",
                "started",
                "type_changed",
                "submitted",
                "amended",
                "closed",
                "station_responded",
                "manager_comment",
              ],
        )
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
  ]);
  const error =
    actions.error ||
    comments.error ||
    evidence.error ||
    responses.error ||
    cashCounts.error ||
    shipments.error ||
    events.error;
  if (error) throw new Error(error.message);
  return {
    ...base,
    audits,
    events: (events.data ?? []).map((event) =>
      stationOnly ? { ...event, before_data: {}, after_data: {} } : event,
    ) as AuditEvent[],
    truncated: false,
    actions: (actions.data ?? []) as AuditAction[],
    comments: ((comments.data ?? []) as AuditComment[]).filter(
      (comment) =>
        !stationOnly ||
        comment.audience === "station" ||
        comment.author_email === authorization.email,
    ),
    evidence: (evidence.data ?? []) as AuditEvidence[],
    responses: (responses.data ?? []) as AuditResponse[],
    cashCounts: (cashCounts.data ?? []) as CashCount[],
    shipments: (shipments.data ?? []) as AuditShipment[],
  };
}

export function ymdInKolkata(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function auditCycleFor(
  type: AuditType,
  date: string,
  selectedSlot?: string,
) {
  return auditCycle(type, date, selectedSlot);
}

export function auditNumber(stationCode: string, date: string) {
  return `AUD-${date.replaceAll("-", "")}-${stationCode.replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function snapshotStation(station: AuditStation) {
  return {
    station_code: station.station_code,
    station_name: station.station_name,
    city: station.city,
    cluster: station.cluster ?? station.cluster_name,
  };
}

export async function createStationAudit(input: {
  companyId: string;
  authorization: AuthorizationContext;
  auditTypeId: string;
  locationId: string;
  scheduledDate: string;
  scheduledTime: string;
  periodSlot?: string;
  assignedUserId?: string;
  reason?: string;
  source?: string;
  /** Outside the monthly programme: no date window and no planned slot is used. */
  unscheduled?: boolean;
  /** Begins at once when the auditor is the person creating it. */
  startNow?: boolean;
  /** The caller has confirmed this person may place an audit at any eligible station. */
  anyStation?: boolean;
}) {
  if (
    !input.anyStation &&
    !canUseStationAuditLocation(input.authorization, input.locationId)
  )
    throw new Error("This station is outside your Ops Pulse access.");
  const [typeResult, master] = await Promise.all([
    db()
      .from("ops_audit_types")
      .select("*")
      .eq("company_id", input.companyId)
      .eq("id", input.auditTypeId)
      .eq("is_active", true)
      .maybeSingle(),
    loadStationAuditMaster(input.companyId),
  ]);
  if (typeResult.error) throw new Error(typeResult.error.message);
  if (!typeResult.data)
    throw new Error("Choose an active audit type from Audit Master.");
  const type = mapType(typeResult.data);
  const stations = await loadAuditStations(
    input.companyId,
    input.anyStation
      ? { hasAllLocationAccess: true, locationScopeIds: [] }
      : input.authorization,
    master.programmeSettings,
  );
  const station = stations.find((row) => row.id === input.locationId);
  if (!station)
    throw new Error("This station is unavailable or outside your scope.");
  // With any-station reach the auditor may come from another station's team.
  const assignees = await loadAuditAssignees(
    input.companyId,
    master.programmeSettings.scheduler_role_ids,
    input.anyStation ? stations.map((row) => row.id) : [station.id],
  );
  const assignee = assignees.find(
    (row) => row.id === (input.assignedUserId || input.authorization.userId),
  );
  if (!assignee)
    throw new Error(
      input.anyStation
        ? "Choose an active user who holds an audit manager role."
        : "Choose an active auditor with audit access to this station.",
    );
  const crossStation = !assignee.stationIds.includes(station.id);
  const startNow =
    input.startNow === true && assignee.id === input.authorization.userId;
  const scheduledDate = input.startNow ? ymdInKolkata() : input.scheduledDate;
  const cycle = input.unscheduled
    ? {
        cycleKey: scheduledDate.slice(0, 7),
        periodSlot: `unscheduled-${randomUUID().slice(0, 8)}`,
      }
    : auditCycleFor(type, scheduledDate, input.periodSlot);
  const scheduledFor = input.startNow
    ? new Date().toISOString()
    : auditTimestamp(scheduledDate, input.scheduledTime);
  const responseDue = new Date(
    Date.parse(scheduledFor) + type.default_response_hours * 60 * 60 * 1000,
  ).toISOString();
  const result = await db()
    .from("ops_station_audits")
    .insert({
      company_id: input.companyId,
      audit_number: auditNumber(station.station_code, scheduledDate),
      audit_type_id: type.id,
      location_id: station.id,
      station_snapshot: snapshotStation(station),
      cycle_key: cycle.cycleKey,
      period_slot: cycle.periodSlot,
      scheduled_for: scheduledFor,
      scheduled_reason: String(input.reason ?? "").trim() || null,
      schedule_source: input.unscheduled
        ? "unscheduled"
        : (input.source ?? "manual"),
      status_code: startNow ? "in_progress" : "scheduled",
      ...(startNow ? { started_at: scheduledFor } : {}),
      // Sent only when set, so planned audits save before the database update too.
      ...(crossStation ? { cross_station: true } : {}),
      assigned_to: assignee.id,
      assigned_name: assignee.name,
      assigned_email: assignee.email,
      assignment_verified: true,
      scheduled_by: input.authorization.userId,
      response_due_at: responseDue,
    })
    .select("id,audit_number")
    .single();
  if (result.error) {
    if (result.error.code === "23505")
      throw new Error(
        "This station already has this audit programme slot. Change the date or the configured period slot.",
      );
    // Before the database update, the window rule still rejects audits outside the programme.
    if (
      isAuditSchemaPending(result.error) ||
      (input.unscheduled &&
        /audit window|configured window|already has an audit/i.test(
          result.error.message,
        ))
    )
      throw new Error(auditSchemaPendingMessage);
    throw new Error(result.error.message);
  }
  await writeStationAuditEvent({
    companyId: input.companyId,
    auditId: result.data.id,
    eventType: "scheduled",
    authorization: input.authorization,
    after: {
      scheduledFor,
      cycle,
      assigned_to: assignee.id,
      assigned_name: assignee.name,
      source: input.unscheduled ? "unscheduled" : (input.source ?? "manual"),
      cross_station: crossStation,
    },
  });
  if (startNow)
    await writeStationAuditEvent({
      companyId: input.companyId,
      auditId: result.data.id,
      eventType: "started",
      authorization: input.authorization,
      before: { status: "scheduled" },
      after: { status: "in_progress" },
    });
  return result.data;
}

export async function writeStationAuditEvent(input: {
  companyId: string;
  auditId: string;
  eventType: string;
  authorization?: Pick<
    AuthorizationContext,
    "userId" | "fullName" | "email" | "roleName" | "roleCode"
  >;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}) {
  const event = await db()
    .from("ops_station_audit_events")
    .insert({
      company_id: input.companyId,
      audit_id: input.auditId,
      event_type: input.eventType,
      before_data: input.before ?? {},
      after_data: input.after ?? {},
      actor_user_id: input.authorization?.userId ?? null,
      actor_name: input.authorization?.fullName ?? null,
      actor_email: input.authorization?.email ?? null,
      actor_role:
        input.authorization?.roleName ?? input.authorization?.roleCode ?? null,
    });
  if (event.error) throw new Error(event.error.message);
}

export function isGoogleDriveUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "drive.google.com" ||
        url.hostname.endsWith(".drive.google.com"))
    );
  } catch {
    return false;
  }
}

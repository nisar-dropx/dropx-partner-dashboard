import "server-only";

import { randomUUID } from "node:crypto";
import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
  video_link_help: string | null;
  email_subject_template: string | null;
  email_body_template: string | null;
  recipient_rules: string[];
  cc_rules: string[];
  is_active: boolean;
  sort_order: number;
};

export type AuditSection = { id: string; audit_type_id: string; code: string; name: string; guidance: string | null; sort_order: number; is_active: boolean };
export type AuditChecklistItem = {
  id: string; audit_type_id: string; section_id: string | null; code: string; label: string; guidance: string | null;
  response_type: string; response_options: Array<{ value: string; label: string; is_compliant: boolean | null; requires_action: boolean; requires_evidence: boolean }>; is_required: boolean;
  evidence_rule: string; action_rule: string; default_severity_code: string | null; sort_order: number; is_active: boolean;
};
export type AuditOption = { id: string; option_group: string; code: string; label: string; description: string | null; metadata: Record<string, unknown>; sort_order: number; is_active: boolean };
export type AuditStation = { id: string; station_code: string; station_name: string | null; city: string | null; cluster: string | null; cluster_name: string | null; station_email: string | null; station_manager_email: string | null; cluster_manager_email: string | null; ops_manager_email: string | null; finance_manager_email: string | null; location_model_id: string | null; is_ho: boolean };
export type AuditProgrammeSettings = { company_id: string; scheduler_role_ids: string[]; responder_role_ids: string[]; excluded_location_model_ids: string[]; excluded_location_ids: string[]; exclude_head_office: boolean };
export type AuditRole = { id: string; code: string; name: string; product_code: string | null };
export type AuditLocationModel = { id: string; code: string; name: string };
export type StationAudit = {
  id: string; audit_number: string; audit_type_id: string; location_id: string; cycle_key: string; period_slot: string; scheduled_for: string;
  scheduled_reason: string | null; schedule_source: string; status_code: string; assigned_to: string | null; assigned_name: string | null;
  started_at: string | null;
  response_due_at: string | null; station_response_status: string; system_cash_amount: number | null; physical_cash_amount: number | null;
  cash_variance_amount: number | null; system_shipment_count: number | null; physical_shipment_count: number | null;
  shipment_missing_count: number; shipment_excess_count: number; shipment_unresolved_count: number; video_call_url: string | null;
  overall_summary: string | null; station_summary: string | null; manager_summary: string | null; score: number | null; email_status: string;
  ops_audit_types?: Pick<AuditType, "code" | "name" | "requires_video_link" | "default_response_hours" | "video_link_help"> | null;
  stations?: Pick<AuditStation, "station_code" | "station_name" | "city" | "cluster" | "cluster_name"> | null;
};

type AuditAction = { id: string; audit_id: string; title: string; corrective_action: string; preventive_action: string | null; severity_code: string | null; status_code: string; owner_name: string | null; owner_email: string | null; due_at: string | null; completion_note: string | null };
type AuditComment = { id: string; audit_id: string; body: string; audience: string; requests_station_response: boolean; author_name: string | null; author_email: string | null; created_at: string };
type AuditEvidence = { id: string; audit_id: string; file_name: string | null; media_url: string; caption: string | null; evidence_kind_code: string | null; uploaded_at: string };
type AuditResponse = { id: string; audit_id: string; checklist_item_id: string; response_value: unknown; is_compliant: boolean | null; remarks: string | null };
type CashCount = { id: string; audit_id: string; cash_side: string; denomination_option_id: string | null; denomination_value: number; note_count: number; computed_amount: number; notes: string | null };
type AuditShipment = { id: string; audit_id: string; tracking_id: string; system_status_code: string | null; physical_status_code: string | null; discrepancy_code: string | null; remarks: string | null; required_action: string | null; due_at: string | null; is_resolved: boolean };

export type StationAuditWorkspace = {
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

export function canUseStationAuditLocation(authorization: Pick<AuthorizationContext, "hasAllLocationAccess" | "locationScopeIds">, locationId: string) {
  return authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(locationId);
}

export function canManageStationAudits(authorization: AuthorizationContext, settings: AuditProgrammeSettings) {
  return authorization.isMasterOwner || authorization.effectiveRoleIds.some((roleId) => settings.scheduler_role_ids.includes(roleId));
}

export function canRespondToStationAudits(authorization: AuthorizationContext, settings: AuditProgrammeSettings) {
  const permission = authorization.permissions.station_audits;
  return Boolean((permission?.canAdd || permission?.canEdit) && authorization.effectiveRoleIds.some((roleId) => settings.responder_role_ids.includes(roleId)));
}

export function isStationAuditEligible(station: Pick<AuditStation, "id" | "location_model_id" | "is_ho">, settings: AuditProgrammeSettings) {
  return !settings.excluded_location_ids.includes(station.id) &&
    !settings.excluded_location_model_ids.includes(station.location_model_id ?? "") &&
    !(settings.exclude_head_office && station.is_ho);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function responseOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = record(item);
    const option = String(row.value ?? "").trim();
    return option ? {
      value: option,
      label: String(row.label ?? option).trim() || option,
      is_compliant: typeof row.is_compliant === "boolean" ? row.is_compliant : null,
      requires_action: row.requires_action === true,
      requires_evidence: row.requires_evidence === true
    } : null;
  }).filter((item): item is { value: string; label: string; is_compliant: boolean | null; requires_action: boolean; requires_evidence: boolean } => Boolean(item));
}

function mapType(row: any): AuditType {
  return { ...row, scheduling_config: record(row.scheduling_config), recipient_rules: stringList(row.recipient_rules), cc_rules: stringList(row.cc_rules) } as AuditType;
}
function mapItem(row: any): AuditChecklistItem { return { ...row, response_options: responseOptions(row.response_options) } as AuditChecklistItem; }
function mapOption(row: any): AuditOption { return { ...row, metadata: record(row.metadata) } as AuditOption; }

export async function loadStationAuditMaster(companyId: string) {
  const [types, sections, items, options, programmeSettings] = await Promise.all([
    db().from("ops_audit_types").select("*").eq("company_id", companyId).order("sort_order").order("name"),
    db().from("ops_audit_checklist_sections").select("*").eq("company_id", companyId).eq("is_active", true).order("sort_order").order("name"),
    db().from("ops_audit_checklist_items").select("*").eq("company_id", companyId).eq("is_active", true).order("sort_order").order("label"),
    db().from("ops_audit_reference_options").select("*").eq("company_id", companyId).eq("is_active", true).order("option_group").order("sort_order").order("label"),
    db().from("ops_audit_programme_settings").select("company_id,scheduler_role_ids,responder_role_ids,excluded_location_model_ids,excluded_location_ids,exclude_head_office").eq("company_id", companyId).maybeSingle()
  ]);
  const error = types.error || sections.error || items.error || options.error || programmeSettings.error;
  if (error) throw new Error(error.message);
  return {
    auditTypes: (types.data ?? []).map(mapType),
    sections: (sections.data ?? []) as AuditSection[],
    checklistItems: (items.data ?? []).map(mapItem),
    options: (options.data ?? []).map(mapOption),
    programmeSettings: {
      company_id: companyId,
      scheduler_role_ids: stringList(programmeSettings.data?.scheduler_role_ids),
      responder_role_ids: stringList(programmeSettings.data?.responder_role_ids),
      excluded_location_model_ids: stringList(programmeSettings.data?.excluded_location_model_ids),
      excluded_location_ids: stringList(programmeSettings.data?.excluded_location_ids),
      exclude_head_office: programmeSettings.data?.exclude_head_office === true
    } satisfies AuditProgrammeSettings
  };
}

export async function loadAuditMasterConfiguration(companyId: string) {
  const [master, roles, locationModels, stations] = await Promise.all([
    loadStationAuditMaster(companyId),
    db().from("user_roles").select("id,code,name,product_code").eq("company_id", companyId).eq("is_active", true).or("product_code.eq.operations,code.eq.LOCATION").order("product_code").order("name"),
    db().from("location_models").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("name"),
    db().from("stations").select("id,station_code,station_name,city,location_model_id,is_ho").eq("company_id", companyId).eq("is_active", true).eq("hide_from_location_list", false).order("station_code")
  ]);
  const error = roles.error || locationModels.error || stations.error;
  if (error) throw new Error(error.message);
  return {
    ...master,
    roles: (roles.data ?? []) as AuditRole[],
    locationModels: (locationModels.data ?? []) as AuditLocationModel[],
    allStations: (stations.data ?? []) as Array<Pick<AuditStation, "id" | "station_code" | "station_name" | "city" | "location_model_id" | "is_ho">>
  };
}

export async function loadAuditStations(companyId: string, authorization: Pick<AuthorizationContext, "hasAllLocationAccess" | "locationScopeIds">, settings: AuditProgrammeSettings) {
  let query = db().from("stations").select("id,station_code,station_name,city,cluster,cluster_name,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email,location_model_id,is_ho")
    .eq("company_id", companyId).eq("is_active", true).eq("hide_from_location_list", false).order("station_code");
  if (!authorization.hasAllLocationAccess) {
    if (!authorization.locationScopeIds.length) return [] as AuditStation[];
    query = query.in("id", authorization.locationScopeIds);
  }
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as AuditStation[]).filter((station) => isStationAuditEligible(station, settings));
}

export async function loadStationAuditWorkspace(companyId: string, authorization: AuthorizationContext, from: string, to: string, stationOnly = false): Promise<StationAuditWorkspace> {
  const master = await loadStationAuditMaster(companyId);
  const stations = await loadAuditStations(companyId, authorization, master.programmeSettings);
  const stationIds = stations.map((station) => station.id);
  if (!stationIds.length) return { ...master, stations, audits: [], actions: [], comments: [], evidence: [], responses: [], cashCounts: [], shipments: [] };
  let auditsQuery = db().from("ops_station_audits")
    .select("*,ops_audit_types(code,name,requires_video_link,default_response_hours,video_link_help),stations(station_code,station_name,city,cluster,cluster_name)")
    .eq("company_id", companyId).in("location_id", stationIds);
  auditsQuery = stationOnly
    ? auditsQuery.eq("status_code", "awaiting_station_response")
    : auditsQuery.gte("scheduled_for", `${from}T00:00:00.000Z`).lte("scheduled_for", `${to}T23:59:59.999Z`);
  const auditsResult = await auditsQuery.order("scheduled_for", { ascending: true }).limit(1500);
  if (auditsResult.error) throw new Error(auditsResult.error.message);
  const audits = ((auditsResult.data ?? []) as StationAudit[]).filter((audit) => !stationOnly || (audit.status_code === "awaiting_station_response" && audit.station_response_status === "requested"));
  const auditIds = audits.map((audit) => audit.id);
  if (!auditIds.length) return { ...master, stations, audits, actions: [], comments: [], evidence: [], responses: [], cashCounts: [], shipments: [] };
  const [actions, comments, evidence, responses, cashCounts, shipments] = await Promise.all([
    db().from("ops_station_audit_actions").select("id,audit_id,title,corrective_action,preventive_action,severity_code,status_code,owner_name,owner_email,due_at,completion_note").eq("company_id", companyId).in("audit_id", auditIds).order("due_at", { ascending: true }),
    db().from("ops_station_audit_comments").select("id,audit_id,body,audience,requests_station_response,author_name,author_email,created_at").eq("company_id", companyId).in("audit_id", auditIds).order("created_at", { ascending: true }),
    db().from("ops_station_audit_evidence").select("id,audit_id,file_name,media_url,caption,evidence_kind_code,uploaded_at").eq("company_id", companyId).in("audit_id", auditIds).order("uploaded_at", { ascending: false }),
    db().from("ops_station_audit_check_responses").select("id,audit_id,checklist_item_id,response_value,is_compliant,remarks").eq("company_id", companyId).in("audit_id", auditIds),
    db().from("ops_station_audit_cash_counts").select("id,audit_id,cash_side,denomination_option_id,denomination_value,note_count,computed_amount,notes").eq("company_id", companyId).in("audit_id", auditIds).order("denomination_value", { ascending: false }),
    db().from("ops_station_audit_shipments").select("id,audit_id,tracking_id,system_status_code,physical_status_code,discrepancy_code,remarks,required_action,due_at,is_resolved").eq("company_id", companyId).in("audit_id", auditIds).order("created_at")
  ]);
  const error = actions.error || comments.error || evidence.error || responses.error || cashCounts.error || shipments.error;
  if (error) throw new Error(error.message);
  return { ...master, stations, audits, actions: (actions.data ?? []) as AuditAction[], comments: (comments.data ?? []) as AuditComment[], evidence: (evidence.data ?? []) as AuditEvidence[], responses: (responses.data ?? []) as AuditResponse[], cashCounts: (cashCounts.data ?? []) as CashCount[], shipments: (shipments.data ?? []) as AuditShipment[] };
}

export function ymdInKolkata(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)); }
function weekKey(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function monthKey(value: string) { return value.slice(0, 7); }
function scheduledDate(value: string, time: string) {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Set a valid scheduled time in Audit Master before generating the programme.");
  const [hours, minutes] = time.split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new Error("Set a valid scheduled time in Audit Master before generating the programme.");
  // Asia/Kolkata has a fixed UTC+05:30 offset; deliberately preserve the configured local time.
  return new Date(`${value}T${time}:00+05:30`).toISOString();
}
function mondayOf(value: string) {
  const date = new Date(`${value}T12:00:00Z`); const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1); return date.toISOString().slice(0, 10);
}
function dateAdd(value: string, days: number) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function nextMonthStart(value: string) { const date = new Date(`${value.slice(0, 7)}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); return date.toISOString().slice(0, 10); }
function dayInMonth(value: string, day: number) { const month = value.slice(0, 7); const last = new Date(`${month}-01T12:00:00Z`); last.setUTCMonth(last.getUTCMonth() + 1, 0); return `${month}-${String(Math.min(Math.max(day, 1), last.getUTCDate())).padStart(2, "0")}`; }

function periodSlots(type: AuditType) {
  const configured = (record(type.scheduling_config).period_slots);
  return Array.isArray(configured) ? configured.map((row) => record(row)).filter((row) => String(row.code ?? "").trim()) : [];
}

export function auditCycleFor(type: AuditType, date: string, selectedSlot?: string) {
  if (!isDate(date)) throw new Error("Choose a valid audit date.");
  return { cycleKey: type.cadence_unit === "weekly" ? weekKey(date) : monthKey(date), periodSlot: selectedSlot || "standard" };
}

export function auditNumber(stationCode: string, date: string) {
  return `AUD-${date.replaceAll("-", "")}-${stationCode.replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function snapshotStation(station: AuditStation) {
  return { station_code: station.station_code, station_name: station.station_name, city: station.city, cluster: station.cluster ?? station.cluster_name };
}

export async function createStationAudit(input: { companyId: string; authorization: AuthorizationContext; auditTypeId: string; locationId: string; scheduledDate: string; scheduledTime: string; periodSlot?: string; assignedName?: string; reason?: string; source?: string }) {
  if (!canUseStationAuditLocation(input.authorization, input.locationId)) throw new Error("This station is outside your Ops Pulse access.");
  const [typeResult, master] = await Promise.all([
    db().from("ops_audit_types").select("*").eq("company_id", input.companyId).eq("id", input.auditTypeId).eq("is_active", true).maybeSingle(),
    loadStationAuditMaster(input.companyId)
  ]);
  if (typeResult.error) throw new Error(typeResult.error.message);
  if (!typeResult.data) throw new Error("Choose an active audit type from Audit Master.");
  const type = mapType(typeResult.data);
  const stations = await loadAuditStations(input.companyId, input.authorization, master.programmeSettings);
  const station = stations.find((row) => row.id === input.locationId);
  if (!station) throw new Error("This station is unavailable or outside your scope.");
  const cycle = auditCycleFor(type, input.scheduledDate, input.periodSlot);
  const scheduledFor = scheduledDate(input.scheduledDate, input.scheduledTime);
  const responseDue = new Date(Date.parse(scheduledFor) + type.default_response_hours * 60 * 60 * 1000).toISOString();
  const result = await db().from("ops_station_audits").insert({
    company_id: input.companyId, audit_number: auditNumber(station.station_code, input.scheduledDate), audit_type_id: type.id, location_id: station.id,
    station_snapshot: snapshotStation(station), cycle_key: cycle.cycleKey, period_slot: cycle.periodSlot, scheduled_for: scheduledFor,
    scheduled_reason: String(input.reason ?? "").trim() || null, schedule_source: input.source ?? "manual", status_code: "scheduled",
    assigned_to: input.authorization.userId, assigned_name: String(input.assignedName ?? "").trim() || input.authorization.fullName || null,
    assigned_email: input.authorization.email, scheduled_by: input.authorization.userId, response_due_at: responseDue
  }).select("id,audit_number").single();
  if (result.error) {
    if (result.error.code === "23505") throw new Error("This station already has this audit programme slot. Change the date or the configured period slot.");
    throw new Error(result.error.message);
  }
  await writeStationAuditEvent({ companyId: input.companyId, auditId: result.data.id, eventType: "scheduled", authorization: input.authorization, after: { scheduledFor, cycle, source: input.source ?? "manual" } });
  return result.data;
}

export async function writeStationAuditEvent(input: { companyId: string; auditId: string; eventType: string; authorization?: Pick<AuthorizationContext, "userId" | "fullName" | "email" | "roleName" | "roleCode">; before?: Record<string, unknown>; after?: Record<string, unknown> }) {
  const event = await db().from("ops_station_audit_events").insert({ company_id: input.companyId, audit_id: input.auditId, event_type: input.eventType, before_data: input.before ?? {}, after_data: input.after ?? {}, actor_user_id: input.authorization?.userId ?? null, actor_name: input.authorization?.fullName ?? null, actor_email: input.authorization?.email ?? null, actor_role: input.authorization?.roleName ?? input.authorization?.roleCode ?? null });
  if (event.error) throw new Error(event.error.message);
}

export function isGoogleDriveUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "drive.google.com" || url.hostname.endsWith(".drive.google.com")); } catch { return false; }
}

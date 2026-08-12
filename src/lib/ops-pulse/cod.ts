import { cache } from "react";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadShipmentCountAssociateDays } from "@/lib/ops-pulse/capacity-shipments";

export const codFormTypes = ["amazon", "flipkart"] as const;
export const codClients = ["Amazon", "Flipkart"] as const;
export const codValidationStatuses = ["Pending", "Matched", "Short", "Excess", "Rejected"] as const;
export const executiveReconciliationStatuses = ["Pending", "Completed", "Pending Amount", "Mismatch", "Not applicable"] as const;

export type CodFormType = typeof codFormTypes[number];
export type CodClient = typeof codClients[number];
export type CodValidationStatus = typeof codValidationStatuses[number];
export type ExecutiveReconciliationStatus = typeof executiveReconciliationStatuses[number];

export type CodAttachment = {
  field: string;
  label: string;
  file_name: string;
  content_type: string | null;
  file_size: number;
  storage_bucket: string;
  storage_path: string;
};

type Relation<T> = T | T[] | null | undefined;

export type CodLocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  city?: string | null;
  state?: string | null;
  region?: string | null;
  aom?: string | null;
  cluster_manager?: string | null;
  cluster?: string | null;
  station_manager_email?: string | null;
  hide_from_location_list?: boolean | null;
  providers?: Relation<{ code?: string | null; name?: string | null }>;
  location_models?: Relation<{ code?: string | null; name?: string | null }>;
};

export type CodSubmissionRow = {
  id: string;
  submission_no: string;
  form_type: CodFormType | null;
  client: CodClient | null;
  channel: string | null;
  location_id: string | null;
  station_code: string | null;
  cod_period_from: string | null;
  cod_period_to: string | null;
  cod_date: string | null;
  deposit_date: string | null;
  remittance_creation_date: string | null;
  remittance_creation_time: string | null;
  remittance_submission_date: string | null;
  remittance_amount: number | string | null;
  cod_as_per_erp: number | string | null;
  cod_amount: number | string | null;
  deposited_amount: number | string | null;
  remittance_code?: string | null;
  deposit_window?: string | null;
  cod_master_id?: string | null;
  payment_mode: string | null;
  reference_no: string | null;
  proof_url: string | null;
  submitter_name: string | null;
  remarks: string | null;
  status: string;
  validation_status: CodValidationStatus;
  validated_amount: number | string | null;
  validated_at: string | null;
  validation_remarks: string | null;
  form_payload?: Record<string, unknown> | null;
  validation_payload: Record<string, unknown> | null;
  attachments: CodAttachment[] | null;
  deposit_slip_attachments?: CodAttachment[] | null;
  ai_status?: string | null;
  ai_confidence?: number | string | null;
  ai_summary?: string | null;
  ai_result?: Record<string, unknown> | null;
  created_at: string;
  stations?: CodLocationRow | CodLocationRow[] | null;
};

export type CodStationSettingRow = {
  id: string;
  company_id: string;
  location_id: string;
  station_code: string | null;
  state: string | null;
  cms_agency: string | null;
  agent_name: string | null;
  agent_mobile: string | null;
  cod_deposit_day: "Same Day" | "Next Day";
  pickup_time: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  cod_submission_due_time: string | null;
  eod_submission_due_time: string | null;
  escalation_contact: string | null;
  escalation_email: string | null;
  cod_sheet_link: string | null;
  portal_station_code?: string | null;
  portal_login_url?: string | null;
  portal_username?: string | null;
  portal_secret_name?: string | null;
  amazon_driver_recon_url?: string | null;
  amazon_bank_deposit_url?: string | null;
  driver_recon_due_time?: string | null;
  prepared_deposit_due_time?: string | null;
  portal_check_interval_minutes?: number | string | null;
  portal_checks_enabled?: boolean | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type PortalCheckType = "driver_reconciliation" | "prepared_deposit";

export type PortalCheckRunRow = {
  id: string;
  company_id: string;
  location_id: string | null;
  cod_master_id: string | null;
  station_code: string;
  portal_station_code: string | null;
  check_date: string;
  check_type: PortalCheckType;
  status: "Queued" | "Running" | "Pass" | "Fail" | "Manual Review" | "Error" | "Skipped";
  pending_count: number | string;
  pending_amount: number | string;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  raw_result: Record<string, unknown> | null;
  attempt_count: number | string;
  last_checked_at: string | null;
  next_check_at: string | null;
  error_message: string | null;
  created_at: string;
  stations?: CodLocationRow | CodLocationRow[] | null;
};

export type OpsDailySubmissionRow = {
  id: string;
  submission_no: string;
  location_id: string | null;
  station_code: string | null;
  business_date: string;
  submitter_name: string | null;
  remittance_codes: string[] | null;
  attachments: CodAttachment[] | null;
  checklist_payload?: Record<string, unknown> | null;
  status: string;
  manager_status: string;
  manager_remarks?: string | null;
  ai_status: string | null;
  ai_confidence: number | string | null;
  ai_summary: string | null;
  created_at: string;
  stations?: CodLocationRow | CodLocationRow[] | null;
};

export type ShipmentExecutiveRow = {
  id: string;
  client: string | null;
  work_date: string;
  station_code: string;
  provider_employee_id: string;
  provider_employee_name: string | null;
  shipment_type: string | null;
  total_delivery: number | string | null;
  total_activity: number | string | null;
  updated_at: string | null;
};

export type DriverReconciliationRosterRow = {
  id: string;
  business_date: string;
  location_id: string | null;
  station_code: string;
  portal_station_code: string | null;
  provider_employee_id: string;
  associate_name: string | null;
  reconciliation_state: string | null;
  pending_amount: number | string | null;
  pending_details: DriverReconciliationPendingDetail[] | null;
  last_detail_checked_at: string | null;
  raw_row: Record<string, unknown> | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type DriverReconciliationPendingDetail = {
  tracking_id?: string | null;
  shipment_id?: string | null;
  package_id?: string | null;
  order_id?: string | null;
  amount?: number | string | null;
  status?: string | null;
  description?: string | null;
  raw_row?: Record<string, unknown> | null;
};

export type CodExecutiveReconciliationRow = {
  id: string;
  business_date: string;
  location_id: string | null;
  station_code: string;
  provider_employee_id: string;
  source_associate_name: string | null;
  manual_associate_name: string | null;
  shipment_type: string | null;
  total_delivery: number | string | null;
  total_activity: number | string | null;
  reconciliation_status: ExecutiveReconciliationStatus;
  pending_amount: number | string | null;
  expected_amount: number | string | null;
  cash_500_count: number | string | null;
  cash_200_count: number | string | null;
  cash_100_count: number | string | null;
  cash_50_count: number | string | null;
  cash_20_count: number | string | null;
  cash_10_count: number | string | null;
  cash_other_amount: number | string | null;
  collected_amount: number | string | null;
  difference_amount: number | string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string | null;
  stations?: CodLocationRow | CodLocationRow[] | null;
};

export type ExecutiveReconciliationViewRow = {
  key: string;
  reconciliation_id: string | null;
  business_date: string;
  location_id: string | null;
  station_code: string;
  station_name: string | null;
  state: string | null;
  provider_employee_id: string;
  source_associate_name: string | null;
  manual_associate_name: string | null;
  associate_name: string | null;
  shipment_type: string | null;
  total_delivery: number | string | null;
  total_activity: number | string | null;
  reconciliation_status: ExecutiveReconciliationStatus;
  pending_amount: number | string | null;
  expected_amount: number | string | null;
  cash_500_count: number | string | null;
  cash_200_count: number | string | null;
  cash_100_count: number | string | null;
  cash_50_count: number | string | null;
  cash_20_count: number | string | null;
  cash_10_count: number | string | null;
  cash_other_amount: number | string | null;
  collected_amount: number | string | null;
  difference_amount: number | string | null;
  remarks: string | null;
  scc_pending_amount: number | string | null;
  scc_pending_details: DriverReconciliationPendingDetail[] | null;
  scc_last_detail_checked_at: string | null;
  scc_raw_row: Record<string, unknown> | null;
  source_updated_at: string | null;
  updated_at: string | null;
  source: "scc_driver_reconciliation" | "shipment_data" | "manual";
};

export const depositSlipAttachmentFields = [
  ["deposit_slip", "Photo of deposit slip"]
] as const;

/** Letters, digits, spaces, hyphen, underscore, slash (CMS codes). */
export function alphaNumericFromForm(value: FormDataEntryValue | null, field: string, options?: { required?: boolean }) {
  const text = clean(value);
  if (!text) {
    if (options?.required === false) return null;
    throw new Error(`${field} is required.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(text)) {
    throw new Error(`${field} must be alphanumeric (letters and numbers only).`);
  }
  return text;
}

export function alphaNumericRequired(value: FormDataEntryValue | null, field: string) {
  return alphaNumericFromForm(value, field, { required: true }) as string;
}

export const dailySubmissionAttachmentFields = [
  ["driver_reconciliation", "Driver reconciliation screenshot"],
  ["prepared_deposit", "Prepared deposit / liability screenshot"],
  ["remittance_created", "Remittance created screenshot"],
  ["remittance_closed", "Remittance closed screenshot"],
  ["cash_pending", "Cash pending / liability screenshot"],
  ["station_closure", "Station closure / EOD screenshot"],
  ["ops_summary", "Ops performance summary screenshot"]
] as const;

export const dailySubmissionChecklistFields = [
  {
    key: "driver_reconciliation_status",
    label: "Driver reconciliation",
    options: ["Completed - no pending", "Pending drivers", "Mismatch visible", "Not applicable"]
  },
  {
    key: "prepared_deposit_status",
    label: "Prepared deposit",
    options: ["No pending liability", "Prepared with liability", "Pending", "Not applicable"]
  },
  {
    key: "remittance_created_status",
    label: "Remittance created",
    options: ["Created", "Not created", "Not applicable"]
  },
  {
    key: "remittance_closed_status",
    label: "Remittance closed",
    options: ["Closed", "Open", "Not applicable"]
  }
] as const;

export const aiValidationChecklists = {
  daily_submission: [
    "Confirm every uploaded screenshot belongs to the submitted business date or clearly covers the submitted date range.",
    "Driver reconciliation must show no pending driver reconciliation unless the submitter selected an exception status.",
    "Prepared deposit or liability screenshot must show zero pending liability / no amount left to generate, unless an exception amount is declared.",
    "Remittance created screenshot must show the entered remittance code when remittance is applicable.",
    "Remittance closed screenshot must show the remittance closed/completed state when remittance closure is applicable.",
    "Cash pending / liability screenshot must not show unexplained pending COD or station cash.",
    "Station closure / EOD screenshot must indicate that required station EOD steps are completed."
  ],
  cod_submission: [
    "Slip must be a real CMS cash pickup or bank deposit proof, not an unrelated screenshot.",
    "Slip must show the remittance/reference code entered in the submission when visible on the proof.",
    "Slip must show deposit date or transaction date matching the submitted deposit date.",
    "Slip must show amount, station/location, agency/bank/CMS confirmation, or enough details for a manager to verify.",
    "Flag blurry, cropped, duplicate, unrelated, or unreadable proof for manual review."
  ]
} as const;

export const driverReconciliationOptions = [
  "Pending",
  "100% Done -No pendancy",
  "Pending / mismatch",
  "Not applicable"
] as const;

export const prepareDepositOptions = [
  "Pending",
  "Zero Cash at Station",
  "Prepared",
  "Cash pending"
] as const;

export const remittedAmountOptions = [
  "Pending",
  "No Variance",
  "Short",
  "Excess"
] as const;

export const opsValidationOptions = [
  "Pending",
  "No Discrepancy",
  "Discrepancy",
  "Rejected"
] as const;

export function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

export function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

export function numberFromForm(value: FormDataEntryValue | null, field: string) {
  const text = required(value, field).replace(/,/g, "");
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a valid amount.`);
  return Number(parsed.toFixed(2));
}

export function dateFromForm(value: FormDataEntryValue | null, field: string) {
  const text = required(value, field);
  if (Number.isNaN(Date.parse(text))) throw new Error(`Enter a valid ${field.toLowerCase()}.`);
  return text;
}

export function formTypeFromForm(value: FormDataEntryValue | null) {
  const text = required(value, "COD source");
  if (!codFormTypes.includes(text as CodFormType)) throw new Error("Select Amazon or Flipkart COD.");
  return text as CodFormType;
}

export function clientForFormType(formType: CodFormType): CodClient {
  return formType === "amazon" ? "Amazon" : "Flipkart";
}

export function formTypeLabel(formType: string | null | undefined) {
  if (formType === "amazon") return "Amazon";
  if (formType === "flipkart") return "Flipkart";
  return "-";
}

export function amountValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatAmount(value: number | string | null | undefined) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  }).format(amountValue(value));
}

export function formatDate(value: string | null | undefined) {
  return formatDashboardDate(value);
}

export function formatDateTime(value: string | null | undefined) {
  return formatDashboardDateTime(value);
}

export function formatTime(value: string | null | undefined) {
  return value ? String(value).slice(0, 5) : "-";
}

export function portalCheckLabel(value: string | null | undefined) {
  if (value === "driver_reconciliation") return "Driver Reconciliation";
  if (value === "prepared_deposit") return "Prepared Deposit";
  return "-";
}

export function variance(row: Pick<CodSubmissionRow, "deposited_amount" | "validated_amount">) {
  return amountValue(row.validated_amount ?? row.deposited_amount) - amountValue(row.deposited_amount);
}

export function firstRelation<T>(value: Relation<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function providerName(location: CodLocationRow | null | undefined) {
  const provider = firstRelation(location?.providers);
  return String(provider?.name ?? provider?.code ?? "").trim();
}

export function locationModelName(location: CodLocationRow | null | undefined) {
  const model = firstRelation(location?.location_models);
  return String(model?.code ?? model?.name ?? "").trim();
}

export function inferFormTypeFromLocation(location: CodLocationRow | null | undefined): CodFormType | "" {
  const text = `${providerName(location)} ${locationModelName(location)}`.toLowerCase();
  if (text.includes("amazon") || text.includes("edsp") || text.includes("xpt")) return "amazon";
  if (text.includes("flipkart") || text.includes("odh") || text.includes("mdh")) return "flipkart";
  return "";
}

export function isAmazonSccCodLocation(location: CodLocationRow | null | undefined) {
  const text = `${providerName(location)} ${locationModelName(location)} ${location?.station_code ?? ""} ${location?.station_name ?? ""}`.toLowerCase();
  return text.includes("amazon") || text.includes("edsp") || text.includes("xpt");
}

export function locationLabel(location: CodLocationRow | null | undefined) {
  if (!location) return "-";
  return location.station_name ? `${location.station_code} - ${location.station_name}` : location.station_code;
}

export function codPeriod(row: Pick<CodSubmissionRow, "cod_period_from" | "cod_period_to" | "cod_date">) {
  const from = row.cod_period_from ?? row.cod_date;
  const to = row.cod_period_to ?? row.cod_period_from ?? row.cod_date;
  if (!from) return "-";
  if (!to || from === to) return formatDate(from);
  return `${formatDate(from)} to ${formatDate(to)}`;
}

export function displayCodAmount(row: Pick<CodSubmissionRow, "form_type" | "remittance_amount" | "cod_as_per_erp" | "cod_amount">) {
  if (row.form_type === "amazon") return amountValue(row.remittance_amount ?? row.cod_amount);
  if (row.form_type === "flipkart") return amountValue(row.cod_as_per_erp ?? row.cod_amount);
  return amountValue(row.cod_amount);
}

export function submittedCodAmount(row: Pick<CodSubmissionRow, "form_type" | "remittance_amount" | "deposited_amount" | "cod_amount">) {
  if (row.form_type === "amazon") return amountValue(row.remittance_amount ?? row.deposited_amount ?? row.cod_amount);
  return amountValue(row.deposited_amount ?? row.cod_amount);
}

export function attachmentsFor(row: Pick<CodSubmissionRow, "attachments">) {
  return Array.isArray(row.attachments) ? row.attachments : [];
}

export function depositAttachmentsFor(row: Pick<CodSubmissionRow, "deposit_slip_attachments" | "attachments">) {
  const depositAttachments = Array.isArray(row.deposit_slip_attachments) ? row.deposit_slip_attachments : [];
  return depositAttachments.length ? depositAttachments : attachmentsFor(row);
}

export function depositSlipViewUrl(submissionId: string) {
  return `/api/ops-pulse/cod/submissions/slip?id=${encodeURIComponent(submissionId)}`;
}

export function isMissingCodSetup(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("cod_submissions") ||
    message.includes("schema cache") ||
    (message.includes("column") && message.includes("does not exist")) ||
    (message.includes("relation") && message.includes("does not exist"));
}

export const loadCodLocations = cache(async (companyId: string, locationScopeIds: string[], hasAllLocationAccess: boolean) => {
  if (!supabaseAdmin) return { locations: [] as CodLocationRow[], error: "Supabase service role key is not configured." };
  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, city, state, region, aom, cluster_manager, cluster, station_manager_email, hide_from_location_list, providers (code, name), location_models (code, name)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("station_code");
  if (error) return { locations: [] as CodLocationRow[], error: error.message };
  const rows = (data ?? []) as CodLocationRow[];
  return {
    locations: hasAllLocationAccess
      ? rows
      : rows.filter((location) => locationScopeIds.includes(location.id) && !location.hide_from_location_list),
    error: null
  };
});

export async function loadCodStationSettings(companyId: string, locationScopeIds: string[], hasAllLocationAccess: boolean) {
  if (!supabaseAdmin) return { rows: [] as CodStationSettingRow[], error: "Supabase service role key is not configured." };
  let query = supabaseAdmin
    .from("cod_station_settings")
    .select("id, company_id, location_id, station_code, state, cms_agency, agent_name, agent_mobile, cod_deposit_day, pickup_time, pickup_window_start, pickup_window_end, cod_submission_due_time, eod_submission_due_time, escalation_contact, escalation_email, cod_sheet_link, portal_station_code, portal_login_url, portal_username, portal_secret_name, amazon_driver_recon_url, amazon_bank_deposit_url, driver_recon_due_time, prepared_deposit_due_time, portal_check_interval_minutes, portal_checks_enabled, is_active, created_at, updated_at")
    .eq("company_id", companyId)
    .order("station_code");
  if (!hasAllLocationAccess) query = query.in("location_id", locationScopeIds.length ? locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data, error } = await query;
  if (error) return { rows: [] as CodStationSettingRow[], error: error.message };
  return { rows: (data ?? []) as CodStationSettingRow[], error: null };
}

export function codSetupMessage(error?: string | null) {
  return `${error ? `${error} ` : ""}Run scripts/cod_station_settings_portal_columns_patch_v1.sql, scripts/ops_pulse_cod_portal_checks_v1.sql, and scripts/cod_driver_reconciliation_roster_v1.sql in Supabase SQL Editor, then refresh this page.`;
}

export async function loadPortalCheckRuns(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  params: { checkDate?: string; locationId?: string; status?: string; checkType?: string }
) {
  if (!supabaseAdmin) return { rows: [] as PortalCheckRunRow[], error: "Supabase service role key is not configured." };
  let query = supabaseAdmin
    .from("ops_portal_check_runs")
    .select("id, company_id, location_id, cod_master_id, station_code, portal_station_code, check_date, check_type, status, pending_count, pending_amount, summary, evidence, raw_result, attempt_count, last_checked_at, next_check_at, error_message, created_at, stations (id, station_code, station_name, state)")
    .eq("company_id", companyId)
    .order("check_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (!hasAllLocationAccess) query = query.in("location_id", locationScopeIds.length ? locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  if (params.checkDate) query = query.eq("check_date", params.checkDate);
  if (params.locationId) query = query.eq("location_id", params.locationId);
  if (params.status) query = query.eq("status", params.status);
  if (params.checkType) query = query.eq("check_type", params.checkType);

  const { data, error } = await query.limit(200);
  if (error) return { rows: [] as PortalCheckRunRow[], error: error.message };
  return { rows: (data ?? []) as PortalCheckRunRow[], error: null };
}

export function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).format(new Date());
}

function executiveRowKey(stationCode: string | null | undefined, providerEmployeeId: string | null | undefined) {
  return `${String(stationCode ?? "").trim().toUpperCase()}::${String(providerEmployeeId ?? "").trim().toUpperCase()}`;
}

export function executiveDisplayName(row: Pick<ExecutiveReconciliationViewRow, "source_associate_name" | "manual_associate_name">) {
  const rawName = row.source_associate_name || row.manual_associate_name || "";
  const name = rawName.split("/")[0]?.trim() || rawName.trim();
  return name || "-";
}

function executiveRawName(row: Pick<ExecutiveReconciliationViewRow, "source_associate_name" | "manual_associate_name">) {
  return executiveDisplayName(row).toLowerCase();
}

export async function loadCodSubmissions(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  params: { fromDate?: string; toDate?: string; locationId?: string; validationStatus?: string; formType?: string }
) {
  if (!supabaseAdmin) return { rows: [] as CodSubmissionRow[], error: "Supabase service role key is not configured." };
  let query = supabaseAdmin
    .from("cod_submissions")
    .select("id, submission_no, form_type, client, channel, location_id, station_code, cod_period_from, cod_period_to, cod_date, deposit_date, remittance_creation_date, remittance_creation_time, remittance_submission_date, remittance_amount, cod_as_per_erp, cod_amount, deposited_amount, remittance_code, deposit_window, cod_master_id, payment_mode, reference_no, proof_url, submitter_name, remarks, status, validation_status, validated_amount, validated_at, validation_remarks, validation_payload, attachments, deposit_slip_attachments, ai_status, ai_confidence, ai_summary, created_at, stations (id, station_code, station_name, state, providers (code, name), location_models (code, name))")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (!hasAllLocationAccess) query = query.in("location_id", locationScopeIds.length ? locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  if (params.fromDate) query = query.gte("cod_period_from", params.fromDate);
  if (params.toDate) query = query.lte("cod_period_to", params.toDate);
  if (params.locationId) query = query.eq("location_id", params.locationId);
  if (params.validationStatus) query = query.eq("validation_status", params.validationStatus);
  if (params.formType) query = query.eq("form_type", params.formType);

  const { data, error } = await query.limit(250);
  if (error) return { rows: [] as CodSubmissionRow[], error: error.message };
  return { rows: (data ?? []) as CodSubmissionRow[], error: null };
}

export async function loadDailySubmissions(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  params: { businessDate?: string; locationId?: string; managerStatus?: string; aiStatus?: string }
) {
  if (!supabaseAdmin) return { rows: [] as OpsDailySubmissionRow[], error: "Supabase service role key is not configured." };
  let query = supabaseAdmin
    .from("ops_daily_submissions")
    .select("id, submission_no, location_id, station_code, business_date, submitter_name, remittance_codes, attachments, checklist_payload, status, manager_status, manager_remarks, ai_status, ai_confidence, ai_summary, created_at, stations (id, station_code, station_name, state, providers (code, name), location_models (code, name))")
    .eq("company_id", companyId)
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (!hasAllLocationAccess) query = query.in("location_id", locationScopeIds.length ? locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  if (params.businessDate) query = query.eq("business_date", params.businessDate);
  if (params.locationId) query = query.eq("location_id", params.locationId);
  if (params.managerStatus) query = query.eq("manager_status", params.managerStatus);
  if (params.aiStatus) query = query.eq("ai_status", params.aiStatus);

  const { data, error } = await query.limit(250);
  if (error) return { rows: [] as OpsDailySubmissionRow[], error: error.message };
  return { rows: (data ?? []) as OpsDailySubmissionRow[], error: null };
}

export async function loadExecutiveReconciliationRows(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean,
  params: { businessDate?: string; locationId?: string; status?: string }
) {
  if (!supabaseAdmin) {
    return {
      businessDate: params.businessDate || todayKolkata(),
      error: "Supabase service role key is not configured.",
      locations: [] as CodLocationRow[],
      rows: [] as ExecutiveReconciliationViewRow[]
    };
  }

  const businessDate = params.businessDate || todayKolkata();
  const { locations, error: locationsError } = await loadCodLocations(companyId, locationScopeIds, hasAllLocationAccess);
  if (locationsError) return { businessDate, locations, rows: [] as ExecutiveReconciliationViewRow[], error: locationsError };

  const amazonCodLocations = locations.filter(isAmazonSccCodLocation);
  const codRosterLocations = amazonCodLocations.length ? amazonCodLocations : locations;
  const scopedLocations = params.locationId
    ? codRosterLocations.filter((location) => location.id === params.locationId)
    : codRosterLocations.slice(0, 1);
  const stationScope = Array.from(new Set(scopedLocations.map((location) => location.station_code).filter(Boolean)));
  if (!stationScope.length) return { businessDate, locations: codRosterLocations, rows: [] as ExecutiveReconciliationViewRow[], error: null };

  const locationsByStation = new Map(
    scopedLocations.map((location) => [String(location.station_code).trim().toUpperCase(), location])
  );

  const rosterResult = await supabaseAdmin
    .from("cod_driver_reconciliation_roster")
    .select("id, business_date, location_id, station_code, portal_station_code, provider_employee_id, associate_name, reconciliation_state, pending_amount, pending_details, last_detail_checked_at, raw_row, first_seen_at, last_seen_at")
    .eq("company_id", companyId)
    .eq("business_date", businessDate)
    .in("station_code", stationScope)
    .order("station_code", { ascending: true })
    .order("associate_name", { ascending: true })
    .limit(2000);
  if (rosterResult.error) return { businessDate, locations: codRosterLocations, rows: [] as ExecutiveReconciliationViewRow[], error: rosterResult.error.message };

  let reconciliationQuery = supabaseAdmin
    .from("cod_executive_reconciliations")
    .select("id, business_date, location_id, station_code, provider_employee_id, source_associate_name, manual_associate_name, shipment_type, total_delivery, total_activity, reconciliation_status, pending_amount, expected_amount, cash_500_count, cash_200_count, cash_100_count, cash_50_count, cash_20_count, cash_10_count, cash_other_amount, collected_amount, difference_amount, remarks, created_at, updated_at, stations (id, station_code, station_name, state)")
    .eq("company_id", companyId)
    .eq("business_date", businessDate);
  if (params.locationId) reconciliationQuery = reconciliationQuery.eq("location_id", params.locationId);
  if (!params.locationId && !hasAllLocationAccess) {
    reconciliationQuery = reconciliationQuery.in("location_id", locationScopeIds.length ? locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
  }
  if (stationScope.length) reconciliationQuery = reconciliationQuery.in("station_code", stationScope);

  const reconciliationResult = await reconciliationQuery.order("station_code", { ascending: true }).order("provider_employee_id", { ascending: true }).limit(2000);
  if (reconciliationResult.error) return { businessDate, locations, rows: [] as ExecutiveReconciliationViewRow[], error: reconciliationResult.error.message };

  const reconciliations = (reconciliationResult.data ?? []) as CodExecutiveReconciliationRow[];
  const reconciliationByKey = new Map(reconciliations.map((row) => [executiveRowKey(row.station_code, row.provider_employee_id), row]));
  const rowsByKey = new Map<string, ExecutiveReconciliationViewRow>();
  ((rosterResult.data ?? []) as DriverReconciliationRosterRow[]).forEach((roster) => {
    if (!roster.provider_employee_id || !roster.station_code) return;
    const key = executiveRowKey(roster.station_code, roster.provider_employee_id);
    const reconciliation = reconciliationByKey.get(key);
    const station = locationsByStation.get(String(roster.station_code).trim().toUpperCase());
    rowsByKey.set(key, {
      key,
      reconciliation_id: reconciliation?.id ?? null,
      business_date: businessDate,
      location_id: reconciliation?.location_id ?? roster.location_id ?? station?.id ?? null,
      station_code: roster.station_code,
      station_name: station?.station_name ?? null,
      state: station?.state ?? null,
      provider_employee_id: roster.provider_employee_id,
      source_associate_name: roster.associate_name ?? reconciliation?.source_associate_name ?? null,
      manual_associate_name: reconciliation?.manual_associate_name ?? null,
      associate_name: roster.associate_name ?? reconciliation?.manual_associate_name ?? null,
      shipment_type: roster.reconciliation_state ?? reconciliation?.shipment_type ?? "SCC Driver Reconciliation",
      total_delivery: reconciliation?.total_delivery ?? 0,
      total_activity: reconciliation?.total_activity ?? 0,
      reconciliation_status: reconciliation?.reconciliation_status ?? "Pending",
      pending_amount: reconciliation?.pending_amount ?? roster.pending_amount ?? 0,
      expected_amount: reconciliation?.expected_amount ?? roster.pending_amount ?? 0,
      cash_500_count: reconciliation?.cash_500_count ?? 0,
      cash_200_count: reconciliation?.cash_200_count ?? 0,
      cash_100_count: reconciliation?.cash_100_count ?? 0,
      cash_50_count: reconciliation?.cash_50_count ?? 0,
      cash_20_count: reconciliation?.cash_20_count ?? 0,
      cash_10_count: reconciliation?.cash_10_count ?? 0,
      cash_other_amount: reconciliation?.cash_other_amount ?? 0,
      collected_amount: reconciliation?.collected_amount ?? 0,
      difference_amount: reconciliation?.difference_amount ?? 0,
      remarks: reconciliation?.remarks ?? null,
      scc_pending_amount: roster.pending_amount,
      scc_pending_details: Array.isArray(roster.pending_details) ? roster.pending_details : [],
      scc_last_detail_checked_at: roster.last_detail_checked_at,
      scc_raw_row: roster.raw_row,
      source_updated_at: roster.last_seen_at,
      updated_at: reconciliation?.updated_at ?? reconciliation?.created_at ?? null,
      source: "scc_driver_reconciliation"
    });
  });

  // Associate selection uses the station's latest available Amazon Daily
  // Shipment Count roster. The report arrives the next day, so the selected COD
  // date must not require shipment rows for that exact date.
  const sourceDate = new Date(`${businessDate}T00:00:00Z`);
  sourceDate.setUTCDate(sourceDate.getUTCDate() - 30);
  const sourceFrom = sourceDate.toISOString().slice(0, 10);
  // A parent station and one of its XPT stations can both contain the same DA
  // in historical shipment rows. Resolve ownership across the complete Amazon
  // network before narrowing to the selected station, otherwise opening each
  // station independently makes the same DA appear in both rosters.
  const networkStationScope = Array.from(new Set(
    codRosterLocations.map((location) => String(location.station_code ?? "").trim().toUpperCase()).filter(Boolean)
  ));
  const associateSourceResult = await loadShipmentCountAssociateDays(
    companyId,
    networkStationScope,
    sourceFrom,
    businessDate
  );
  const latestSourceDateByStation = new Map<string, string>();
  associateSourceResult.data.forEach((associate) => {
    const stationCode = String(associate.station_code ?? "").trim().toUpperCase();
    const workDate = String(associate.work_date ?? "");
    if (!stationCode || !workDate) return;
    const current = latestSourceDateByStation.get(stationCode);
    if (!current || workDate > current) latestSourceDateByStation.set(stationCode, workDate);
  });
  const latestAssociateOwner = new Map<string, (typeof associateSourceResult.data)[number]>();
  associateSourceResult.data
    .filter((associate) => (
      latestSourceDateByStation.get(String(associate.station_code ?? "").trim().toUpperCase())
      === String(associate.work_date ?? "")
    ))
    .forEach((associate) => {
    const providerEmployeeId = String(associate.provider_employee_id ?? "").trim().toUpperCase();
    const stationCode = String(associate.station_code ?? "").trim().toUpperCase();
    const workDate = String(associate.work_date ?? "");
    if (!providerEmployeeId || !stationCode || !workDate) return;

    const current = latestAssociateOwner.get(providerEmployeeId);
    const currentDate = String(current?.work_date ?? "");
    const delivery = Number(associate.total_delivery ?? 0);
    const currentDelivery = Number(current?.total_delivery ?? 0);
    const currentStation = String(current?.station_code ?? "").trim().toUpperCase();
    if (
      !current
      || workDate > currentDate
      || (workDate === currentDate && delivery > currentDelivery)
      || (workDate === currentDate && delivery === currentDelivery && stationCode < currentStation)
    ) {
      latestAssociateOwner.set(providerEmployeeId, associate);
    }
  });
  const latestAssociateByKey = new Map<string, (typeof associateSourceResult.data)[number]>();
  Array.from(latestAssociateOwner.values())
    .filter((associate) => stationScope.includes(String(associate.station_code ?? "").trim().toUpperCase()))
    .forEach((associate) => {
    const providerEmployeeId = String(associate.provider_employee_id ?? "").trim();
    const stationCode = String(associate.station_code ?? "").trim();
    if (!providerEmployeeId || !stationCode) return;
    const key = executiveRowKey(stationCode, providerEmployeeId);
    const current = latestAssociateByKey.get(key);
    if (!current || String(associate.work_date ?? "") > String(current.work_date ?? "")) {
      latestAssociateByKey.set(key, associate);
    }
  });
  Array.from(latestAssociateByKey.values())
    .forEach((associate) => {
    const providerEmployeeId = String(associate.provider_employee_id ?? "").trim();
    const stationCode = String(associate.station_code ?? "").trim();
    if (!providerEmployeeId || !stationCode) return;
    const key = executiveRowKey(stationCode, providerEmployeeId);
    const existing = rowsByKey.get(key);
    if (existing) {
      // Prefer full "Name / DROP / empId" labels when either side has them.
      const shipmentName = String(associate.provider_employee_name ?? "").trim();
      const existingName = String(existing.source_associate_name ?? "").trim();
      if (shipmentName) {
        const prefer = shipmentName.includes("/")
          ? shipmentName
          : existingName.includes("/")
            ? existingName
            : shipmentName;
        existing.source_associate_name = prefer;
        existing.associate_name = prefer;
      }
      // Mark as shipment-backed so Collect cash includes this employee ID.
      existing.source = "shipment_data";
      existing.shipment_type = "Shipment data";
      existing.total_delivery = Number(existing.total_delivery ?? 0) || Number(associate.total_delivery ?? 0);
      existing.total_activity = Number(existing.total_activity ?? 0) || Number(associate.total_delivery ?? 0);
      return;
    }

    const reconciliation = reconciliationByKey.get(key);
    const station = locationsByStation.get(stationCode.toUpperCase());
    rowsByKey.set(key, {
      key,
      reconciliation_id: reconciliation?.id ?? null,
      business_date: businessDate,
      location_id: reconciliation?.location_id ?? station?.id ?? null,
      station_code: stationCode,
      station_name: station?.station_name ?? null,
      state: station?.state ?? null,
      provider_employee_id: providerEmployeeId,
      source_associate_name: associate.provider_employee_name ?? reconciliation?.source_associate_name ?? null,
      manual_associate_name: reconciliation?.manual_associate_name ?? null,
      associate_name: associate.provider_employee_name ?? reconciliation?.source_associate_name ?? reconciliation?.manual_associate_name ?? null,
      shipment_type: reconciliation?.shipment_type ?? "Shipment data",
      total_delivery: reconciliation?.total_delivery ?? associate.total_delivery ?? 0,
      total_activity: reconciliation?.total_activity ?? associate.total_delivery ?? 0,
      reconciliation_status: reconciliation?.reconciliation_status ?? "Pending",
      pending_amount: reconciliation?.pending_amount ?? 0,
      expected_amount: reconciliation?.expected_amount ?? 0,
      cash_500_count: reconciliation?.cash_500_count ?? 0,
      cash_200_count: reconciliation?.cash_200_count ?? 0,
      cash_100_count: reconciliation?.cash_100_count ?? 0,
      cash_50_count: reconciliation?.cash_50_count ?? 0,
      cash_20_count: reconciliation?.cash_20_count ?? 0,
      cash_10_count: reconciliation?.cash_10_count ?? 0,
      cash_other_amount: reconciliation?.cash_other_amount ?? 0,
      collected_amount: reconciliation?.collected_amount ?? 0,
      difference_amount: reconciliation?.difference_amount ?? 0,
      remarks: reconciliation?.remarks ?? null,
      scc_pending_amount: null,
      scc_pending_details: [],
      scc_last_detail_checked_at: null,
      scc_raw_row: null,
      source_updated_at: null,
      updated_at: reconciliation?.updated_at ?? reconciliation?.created_at ?? null,
      source: "shipment_data"
    });
    });

  reconciliations.forEach((reconciliation) => {
    const key = executiveRowKey(reconciliation.station_code, reconciliation.provider_employee_id);
    if (rowsByKey.has(key)) return;
    const station = firstRelation(reconciliation.stations) ?? locationsByStation.get(String(reconciliation.station_code).trim().toUpperCase()) ?? null;
    rowsByKey.set(key, {
      key,
      reconciliation_id: reconciliation.id,
      business_date: reconciliation.business_date,
      location_id: reconciliation.location_id,
      station_code: reconciliation.station_code,
      station_name: station?.station_name ?? null,
      state: station?.state ?? null,
      provider_employee_id: reconciliation.provider_employee_id,
      source_associate_name: reconciliation.source_associate_name,
      manual_associate_name: reconciliation.manual_associate_name,
      associate_name: reconciliation.source_associate_name ?? reconciliation.manual_associate_name,
      shipment_type: reconciliation.shipment_type,
      total_delivery: reconciliation.total_delivery,
      total_activity: reconciliation.total_activity,
      reconciliation_status: reconciliation.reconciliation_status,
      pending_amount: reconciliation.pending_amount,
      expected_amount: reconciliation.expected_amount,
      cash_500_count: reconciliation.cash_500_count,
      cash_200_count: reconciliation.cash_200_count,
      cash_100_count: reconciliation.cash_100_count,
      cash_50_count: reconciliation.cash_50_count,
      cash_20_count: reconciliation.cash_20_count,
      cash_10_count: reconciliation.cash_10_count,
      cash_other_amount: reconciliation.cash_other_amount,
      collected_amount: reconciliation.collected_amount,
      difference_amount: reconciliation.difference_amount,
      remarks: reconciliation.remarks,
      scc_pending_amount: null,
      scc_pending_details: [],
      scc_last_detail_checked_at: null,
      scc_raw_row: null,
      source_updated_at: null,
      updated_at: reconciliation.updated_at ?? reconciliation.created_at,
      source: "manual"
    });
  });

  const requestedStatus = params.status && executiveReconciliationStatuses.includes(params.status as ExecutiveReconciliationStatus)
    ? params.status as ExecutiveReconciliationStatus
    : "";
  const rows = Array.from(rowsByKey.values())
    .filter((row) => !requestedStatus || row.reconciliation_status === requestedStatus)
    .sort((first, second) => `${first.station_code}${executiveRawName(first)}${first.provider_employee_id}`.localeCompare(`${second.station_code}${executiveRawName(second)}${second.provider_employee_id}`));

  return { businessDate, locations: codRosterLocations, rows, error: null };
}

import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendEmail } from "@/lib/email";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";

export type CodTechIssue = {
  id: string;
  locationId: string;
  stationCode: string;
  providerEmployeeId: string;
  associateName: string;
  openedBusinessDate: string;
  status: "Open" | "Resolved";
  remarks: string;
  photoStorageBucket: string | null;
  photoStoragePath: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
};

type RawCodTechIssueRow = {
  id: string;
  location_id: string;
  station_code: string;
  provider_employee_id: string;
  associate_name: string;
  opened_business_date: string;
  status: "Open" | "Resolved";
  remarks: string;
  photo_storage_bucket: string | null;
  photo_storage_path: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
};

function normalize(row: RawCodTechIssueRow): CodTechIssue {
  return {
    id: row.id,
    locationId: row.location_id,
    stationCode: row.station_code,
    providerEmployeeId: row.provider_employee_id,
    associateName: row.associate_name,
    openedBusinessDate: row.opened_business_date,
    status: row.status,
    remarks: row.remarks,
    photoStorageBucket: row.photo_storage_bucket,
    photoStoragePath: row.photo_storage_path,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    resolvedAt: row.resolved_at
  };
}

const SELECT_COLUMNS =
  "id, location_id, station_code, provider_employee_id, associate_name, opened_business_date, status, remarks, photo_storage_bucket, photo_storage_path, created_by, created_by_name, created_at, resolved_by, resolved_by_name, resolved_at";

/**
 * Open tech issues for a station-day (or across every station in scope) —
 * deliberately NOT filtered by business_date, so an issue raised on an
 * earlier day still shows as open today and every day after, until resolved.
 */
export async function loadOpenTechIssues(
  companyId: string,
  locationIds: string[]
): Promise<{ rows: CodTechIssue[]; error: string | null }> {
  if (!supabaseAdmin || !locationIds.length) return { rows: [], error: null };
  const { data, error } = await supabaseAdmin
    .from("cod_tech_issues")
    .select(SELECT_COLUMNS)
    .eq("company_id", companyId)
    .eq("status", "Open")
    .in("location_id", locationIds)
    .order("opened_business_date", { ascending: true });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map(normalize), error: null };
}

/** Every tech issue (open or resolved) for a station-day range, for the COD report view. */
export async function loadTechIssuesForReport(
  companyId: string,
  locationIds: string[],
  fromDate: string,
  toDate: string
): Promise<{ rows: CodTechIssue[]; error: string | null }> {
  if (!supabaseAdmin || !locationIds.length) return { rows: [], error: null };
  const { data, error } = await supabaseAdmin
    .from("cod_tech_issues")
    .select(SELECT_COLUMNS)
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .gte("opened_business_date", fromDate)
    .lte("opened_business_date", toDate)
    .order("opened_business_date", { ascending: false });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map(normalize), error: null };
}

/** One associate's tech-issue hold for a business date, as the cash recon worker expects it. */
export type TechHold = {
  driverId: string;
  since: string;
  status: "held" | "released";
};

function istYmd(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/**
 * Tech-issue holds that apply to `businessDate` at one station. While an issue is open the
 * associate's cash stays with them in Amazon, so it is "held" out of every day from the day
 * it was raised until the day before it is resolved; on the resolve day it is "released" and
 * all of that carried cash counts in that day's expected cash. Never throws — a lookup
 * failure just means no holds (the day computes exactly as before this feature).
 */
export async function loadTechHoldsForDate(
  companyId: string,
  stationCode: string,
  businessDate: string
): Promise<TechHold[]> {
  if (!supabaseAdmin || !stationCode || !businessDate) return [];
  const code = stationCode.trim().toUpperCase();
  // Anything resolved on/after the day before is a candidate (resolved_at is UTC; IST
  // resolve date is computed below).
  const since = new Date(`${businessDate}T00:00:00+05:30`);
  since.setUTCDate(since.getUTCDate() - 1);
  const { data, error } = await supabaseAdmin
    .from("cod_tech_issues")
    .select("provider_employee_id, opened_business_date, status, resolved_at")
    .eq("company_id", companyId)
    .eq("station_code", code)
    .lte("opened_business_date", businessDate)
    .or(`status.eq.Open,resolved_at.gte.${since.toISOString()}`);
  if (error) {
    console.error("loadTechHoldsForDate failed", error.message);
    return [];
  }
  const holds: TechHold[] = [];
  for (const row of data ?? []) {
    const driverId = String(row.provider_employee_id ?? "").trim();
    if (!driverId) continue;
    const resolvedYmd = row.status === "Resolved" && row.resolved_at ? istYmd(row.resolved_at) : null;
    if (resolvedYmd && resolvedYmd < businessDate) continue;
    holds.push({
      driverId,
      since: row.opened_business_date,
      status: resolvedYmd === businessDate ? "released" : "held"
    });
  }
  return holds;
}

/**
 * Raise (or refresh) an open tech issue for one associate at one station,
 * with an optional photo attachment uploaded through the same ops-pulse
 * proof-upload path used elsewhere in COD. If an open issue already exists
 * for this associate, its remarks/photo are updated instead of creating a
 * duplicate (mirrors addCashEntryException's own upsert-by-open-row shape).
 */
export async function raiseTechIssue(params: {
  companyId: string;
  businessDate: string;
  locationId: string;
  stationCode: string;
  providerEmployeeId: string;
  associateName: string;
  remarks: string;
  photo: FormDataEntryValue | null;
  createdBy: string;
  createdByName: string | null;
}): Promise<CodTechIssue> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const providerEmployeeId = params.providerEmployeeId.trim();
  if (!providerEmployeeId) throw new Error("Associate is required for a tech issue.");
  const remarks = params.remarks.trim();
  if (!remarks) throw new Error("Add a remark describing the technical issue.");

  const existing = await supabaseAdmin
    .from("cod_tech_issues")
    .select("id, photo_storage_bucket, photo_storage_path")
    .eq("company_id", params.companyId)
    .eq("location_id", params.locationId)
    .eq("provider_employee_id", providerEmployeeId)
    .eq("status", "Open")
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const attachment = await uploadOpsProof({
    companyId: params.companyId,
    field: "tech_issue_photo",
    file: params.photo,
    label: "Tech issue photo",
    section: "tech-issue",
    submissionId: `${params.locationId}-${providerEmployeeId}`,
    imagesOnly: true
  });

  // Replacing an existing open issue's photo — clean up the old file so it
  // doesn't sit around orphaned once no row references it.
  if (attachment && existing.data?.photo_storage_path) {
    await supabaseAdmin.storage
      .from(existing.data.photo_storage_bucket ?? "ops-pulse-documents")
      .remove([existing.data.photo_storage_path])
      .catch(() => undefined);
  }

  const now = new Date().toISOString();
  const payload = {
    company_id: params.companyId,
    location_id: params.locationId,
    station_code: params.stationCode,
    provider_employee_id: providerEmployeeId,
    associate_name: params.associateName,
    status: "Open" as const,
    remarks,
    ...(attachment ? { photo_storage_bucket: attachment.storage_bucket, photo_storage_path: attachment.storage_path } : {}),
    updated_at: now
  };

  const result = existing.data?.id
    ? await supabaseAdmin.from("cod_tech_issues").update(payload).eq("id", existing.data.id).select(SELECT_COLUMNS).single()
    : await supabaseAdmin.from("cod_tech_issues").insert({
      ...payload,
      id: crypto.randomUUID(),
      opened_business_date: params.businessDate,
      created_by: params.createdBy,
      created_by_name: params.createdByName,
      created_at: now
    }).select(SELECT_COLUMNS).single();
  if (result.error) throw new Error(result.error.message);
  return normalize(result.data as RawCodTechIssueRow);
}

/**
 * Resolve an open tech issue and delete its attached photo (best-effort,
 * never throws — matches clearCashEntryExceptionIfAny's "resolution must
 * succeed even if storage cleanup fails" philosophy). The photo is deleted
 * because it no longer serves any purpose once resolved, not retained
 * indefinitely.
 */
export async function resolveTechIssue(params: {
  companyId: string;
  /** Station the caller was authorised for — the issue must belong to it. */
  locationId: string;
  id: string;
  resolvedBy: string;
  resolvedByName: string | null;
}): Promise<void> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const existing = await supabaseAdmin
    .from("cod_tech_issues")
    .select("id, photo_storage_bucket, photo_storage_path")
    .eq("company_id", params.companyId)
    .eq("location_id", params.locationId)
    .eq("id", params.id)
    .eq("status", "Open")
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) throw new Error("This tech issue is already resolved or does not belong to this station.");

  const now = new Date().toISOString();
  const updated = await supabaseAdmin.from("cod_tech_issues").update({
    status: "Resolved",
    resolved_by: params.resolvedBy,
    resolved_by_name: params.resolvedByName,
    resolved_at: now,
    photo_storage_bucket: null,
    photo_storage_path: null,
    updated_at: now
  }).eq("id", params.id);
  if (updated.error) throw new Error(updated.error.message);

  if (existing.data.photo_storage_path) {
    try {
      await supabaseAdmin.storage
        .from(existing.data.photo_storage_bucket ?? "ops-pulse-documents")
        .remove([existing.data.photo_storage_path]);
    } catch (error) {
      console.error("resolveTechIssue: photo cleanup failed", error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Notify the station's reporting manager (station_manager_email +
 * cod_station_settings.escalation_email — same recipient resolution
 * notifyCodManager already uses for other COD escalations) that a tech
 * issue was raised, mirroring notifyCodManager's insert-then-send-email
 * shape but without requiring a cod_day_closures row (a tech issue can be
 * raised before cash is even submitted for the day).
 */
export async function notifyTechIssueOpened({
  companyId,
  locationId,
  stationCode,
  associateName,
  remarks
}: {
  companyId: string;
  locationId: string;
  stationCode: string;
  associateName: string;
  remarks: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const [stationResult, settingResult] = await Promise.all([
    supabaseAdmin.from("stations").select("station_manager_email")
      .eq("company_id", companyId).eq("id", locationId).maybeSingle(),
    supabaseAdmin.from("cod_station_settings").select("escalation_email")
      .eq("company_id", companyId).eq("location_id", locationId).maybeSingle()
  ]);
  const emails = [
    stationResult.data?.station_manager_email,
    ...String(settingResult.data?.escalation_email ?? "").split(/[;,]/)
  ].map((email) => String(email ?? "").trim().toLowerCase()).filter(Boolean);
  const recipients = [...new Set(emails)];

  const title = `Tech issue raised: ${stationCode} · ${associateName}`;
  const message = `A technical issue was raised for ${associateName} at ${stationCode} and their cash entry is on hold until it is resolved. Reason: ${remarks}`;

  const notification = await supabaseAdmin.from("cod_manager_notifications").insert({
    id: crypto.randomUUID(),
    company_id: companyId,
    closure_id: null,
    location_id: locationId,
    recipient_email: recipients.join(", ") || null,
    notification_type: "tech_issue_opened",
    title,
    message,
    status: "Unread",
    email_status: recipients.length ? "Pending" : "Skipped",
    created_at: new Date().toISOString()
  }).select("id").single();
  if (notification.error) {
    // Notification is best-effort context, not something that should block
    // raising the tech issue itself.
    console.error("notifyTechIssueOpened: unable to record notification", notification.error.message);
    return;
  }

  if (recipients.length && notification.data?.id) {
    try {
      await sendEmail({ companyId, to: recipients, subject: title, body: `${message}\n\nStation: ${stationCode}` });
      await supabaseAdmin.from("cod_manager_notifications").update({ email_status: "Sent" }).eq("id", notification.data.id);
    } catch (error) {
      await supabaseAdmin.from("cod_manager_notifications").update({
        email_status: "Failed",
        email_error: error instanceof Error ? error.message : "Email failed"
      }).eq("id", notification.data.id);
    }
  }
}

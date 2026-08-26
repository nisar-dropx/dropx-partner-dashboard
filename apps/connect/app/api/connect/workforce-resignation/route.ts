import { NextResponse } from "next/server";
import { requireConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { isNonEmployeeProfileType, workforceLabel, workforceTable, type NonEmployeeProfileType } from "../../../../src/lib/workforce-profiles";

const peopleProfileTypes = new Set(["employee", "user", "contractor"]);

function db() {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  return supabaseAdmin;
}

function workforceProfileType(value: unknown): NonEmployeeProfileType {
  const profileType = String(value ?? "");
  if (!isNonEmployeeProfileType(profileType) || peopleProfileTypes.has(profileType)) {
    throw new Error("This role is managed through the People exit workflow.");
  }
  return profileType;
}

function caseStage(status: string) {
  if (["settled", "completed"].includes(status)) return "completed";
  if (["approved", "clearance"].includes(status)) return "clearance";
  if (["rejected", "cancelled"].includes(status)) return "closed";
  return "workforce review";
}

async function context(profileTypeValue: unknown, accountIdValue: unknown) {
  const profileType = workforceProfileType(profileTypeValue);
  const accountId = String(accountIdValue ?? "");
  const account = await requireConnectAccount(profileType, accountId);
  const table = workforceTable(profileType);
  const { data: profile, error } = await db().from(table)
    .select("id, full_name, email, mobile, location_id, is_active, lifecycle_status")
    .eq("company_id", account.companyId)
    .eq("id", account.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!profile) throw new Error(`${workforceLabel(profileType)} profile is unavailable.`);
  return { account, profileType, profile, table };
}

async function serializeCase(row: Record<string, any>) {
  const { data: events, error } = await db().from("workforce_lifecycle_events")
    .select("id, event_code, from_status, to_status, source_portal, remarks, created_at")
    .eq("company_id", row.company_id)
    .eq("lifecycle_case_id", row.id)
    .order("created_at");
  if (error) throw new Error(error.message);
  return {
    id: row.id,
    caseNumber: `WF-${String(row.id).slice(0, 8).toUpperCase()}`,
    scenario: row.case_type,
    status: row.status,
    stage: caseStage(row.status),
    reason: row.reason_details || "Voluntary resignation",
    comments: row.reason_details || "",
    requestedLastWorkingDate: row.requested_effective_date,
    approvedLastWorkingDate: row.approved_effective_date,
    submittedAt: row.created_at,
    settlementStatus: ["settled", "completed"].includes(row.status) ? "completed" : "not started",
    timeline: (events ?? []).map((event) => ({
      id: event.id,
      title: event.event_code.replaceAll("_", " "),
      status: "completed",
      createdAt: event.created_at,
      actorName: event.source_portal === "connect" ? "You" : "Workforce team",
      note: event.remarks
    })),
    tasks: [],
    documents: []
  };
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const profileType = params.get("profileType") || "field_executive";
    const accountId = params.get("accountId") || params.get("executiveId") || "";
    const current = await context(profileType, accountId);
    const [caseResult, policyResult] = await Promise.all([
      db().from("workforce_lifecycle_cases")
        .select("*")
        .eq("company_id", current.account.companyId)
        .eq("profile_type", current.profileType)
        .eq("profile_id", current.account.id)
        .eq("case_type", "resignation")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db().from("hr_exit_policies").select("resignation_notice_days").eq("company_id", current.account.companyId).maybeSingle()
    ]);
    if (caseResult.error || policyResult.error) throw new Error(caseResult.error?.message ?? policyResult.error?.message ?? "Unable to load resignation status.");
    return NextResponse.json({
      ok: true,
      flow: "workforce",
      destination: `Workforce lifecycle · ${workforceLabel(current.profileType)}`,
      policy: { resignation_notice_days: policyResult.data?.resignation_notice_days ?? 0, withdrawal_allowed: false },
      reasons: [],
      exitCase: caseResult.data ? await serializeCase(caseResult.data) : null
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load resignation status." }, { status: 403 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { profileType?: string; accountId?: string; executiveId?: string; effectiveDate?: string; requestedLastWorkingDate?: string; reasonDetails?: string };
    const current = await context(body.profileType || "field_executive", body.accountId || body.executiveId || "");
    const effectiveDate = String(body.effectiveDate ?? body.requestedLastWorkingDate ?? "").trim();
    const reasonDetails = String(body.reasonDetails ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error("Requested last working date is required.");
    if (effectiveDate < new Date().toISOString().slice(0, 10)) throw new Error("Requested last working date cannot be in the past.");
    if (reasonDetails.length < 5) throw new Error("Provide a clear resignation reason.");
    const lifecycleStatus = String(current.profile.lifecycle_status ?? (current.profile.is_active ? "active" : "inactive")).toLowerCase();
    if (!current.profile.is_active || lifecycleStatus !== "active") throw new Error("Only an active workforce profile can submit a resignation.");

    const { data: existing, error: existingError } = await db().from("workforce_lifecycle_cases")
      .select("id")
      .eq("company_id", current.account.companyId)
      .eq("profile_type", current.profileType)
      .eq("profile_id", current.account.id)
      .eq("case_type", "resignation")
      .not("status", "in", '("rejected","settled","cancelled")')
      .limit(1);
    if (existingError) throw new Error(existingError.message);
    if (existing?.length) throw new Error("An active resignation request already exists.");

    const insert = {
      company_id: current.account.companyId,
      field_executive_id: current.profileType === "field_executive" ? current.account.id : null,
      profile_type: current.profileType,
      profile_id: current.account.id,
      profile_location_id: current.profile.location_id,
      case_type: "resignation",
      status: "submitted",
      requested_effective_date: effectiveDate,
      reason_code: "voluntary",
      reason_details: reasonDetails,
      initiated_source: "connect"
    };
    const created = await db().from("workforce_lifecycle_cases").insert(insert).select("id").single();
    if (created.error) throw new Error(created.error.message);
    const update = await db().from(current.table)
      .update({ lifecycle_status: "resignation_pending", updated_at: new Date().toISOString() })
      .eq("company_id", current.account.companyId)
      .eq("id", current.account.id);
    if (update.error) throw new Error(update.error.message);
    const event = await db().from("workforce_lifecycle_events").insert({
      company_id: current.account.companyId,
      lifecycle_case_id: created.data.id,
      field_executive_id: current.profileType === "field_executive" ? current.account.id : null,
      profile_type: current.profileType,
      profile_id: current.account.id,
      event_code: "resignation_submitted",
      from_status: "active",
      to_status: "submitted",
      source_portal: "connect",
      remarks: reasonDetails
    });
    if (event.error) throw new Error(event.error.message);
    return NextResponse.json({ ok: true, notice: "Resignation submitted to the Workforce lifecycle team." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit resignation." }, { status: 400 });
  }
}

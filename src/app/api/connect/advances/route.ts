import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isManagingPartnerDesignation } from "@/lib/approval-designation-labels";
import { connectSessionCookieName, normalizeConnectMobile } from "@/lib/connect-auth";
import { createAppNotification } from "@/lib/app-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType, type WorkforceProfileType, workforceTable } from "@/lib/workforce-profiles";

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function isDirectAdvanceRequester(companyId: string, profileType: WorkforceProfileType, accountId: string) {
  if (!supabaseAdmin) return false;
  const workerColumn = profileType === "employee" ? "employee_id" : "contractor_id";
  const today = indiaToday();
  const engagement = await supabaseAdmin.from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq("worker_type", profileType).eq(workerColumn, accountId).eq("status", "active")
    .limit(1).maybeSingle();
  if (engagement.error || !engagement.data) return false;
  const assignment = await supabaseAdmin.from("hr_work_assignments")
    .select("id,designation_id,is_top_level,effective_from,effective_to")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data) return false;
  if (assignment.data.is_top_level) return true;
  if (!assignment.data.designation_id) return false;
  const designation = await supabaseAdmin.from("designations").select("code,name")
    .eq("company_id", companyId).eq("id", assignment.data.designation_id).maybeSingle();
  if (designation.error || !designation.data) return false;
  return isManagingPartnerDesignation({
    code: designation.data.code as string | null,
    name: String(designation.data.name ?? "")
  });
}

async function resolveAccount(accountId: string, profileType: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (!isWorkforceProfileType(profileType)) throw new Error("Advances are available for workforce accounts only.");

  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Login required.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin
    .from("connect_login_sessions")
    .select("country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  const session = sessionResult.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Login expired.");
  }

  const normalized = normalizeConnectMobile(session.mobile_number, session.country_code);
  const resolvedType = profileType as WorkforceProfileType;
  const table = workforceTable(resolvedType);
  const codeColumn = resolvedType === "employee" ? "employee_code" : "dropx_id";
  const result = await supabaseAdmin
    .from(table)
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as Record<string, unknown> | null;
  if (!row) throw new Error("Workforce account not found.");
  const rowMobile = String(row.mobile ?? "").replace(/\D/g, "");
  const rowCountryCode = String(row.mobile_country_code ?? normalized.countryCode).replace(/\D/g, "") || normalized.countryCode;
  if (rowCountryCode !== normalized.countryCode || (rowMobile !== normalized.mobile && rowMobile !== normalized.localMobile)) {
    throw new Error("Advances are not available for this signed-in account.");
  }
  const profileStatusColumn = resolvedType === "employee" ? "profile_completion_status" : "onboarding_status";
  const profileStatus = String(row[profileStatusColumn] ?? "").trim().toLowerCase();
  const eligibleForAdvance = row.is_active === true && profileStatus === "active";

  let station = "";
  if (row.location_id) {
    const stationResult = await supabaseAdmin.from("stations").select("station_code").eq("id", row.location_id).maybeSingle();
    if (stationResult.error) throw new Error(stationResult.error.message);
    station = String(stationResult.data?.station_code ?? "");
  }
  return {
    accountId: String(row.id),
    companyId: String(row.company_id),
    profileType: resolvedType,
    accountCode: String(row[codeColumn as keyof typeof row] ?? ""),
    name: String(row.full_name ?? ""),
    station,
    designation: String("designation" in row ? row.designation ?? "" : "Employee"),
    eligibleForAdvance
  };
}

function statusCode(message: string) {
  if (message.includes("Login")) return 401;
  if (message.includes("Profile status is Active")) return 403;
  return 400;
}

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const account = await resolveAccount(
      request.nextUrl.searchParams.get("accountId") ?? "",
      request.nextUrl.searchParams.get("profileType") ?? ""
    );
    const result = await supabaseAdmin
      .from("payment_advance_requests")
      .select("id, amount, purpose, status, approved_amount, decision_comment, requested_at, updated_at")
      .eq("company_id", account.companyId)
      .eq("profile_type", account.profileType)
      .eq("account_id", account.accountId)
      .order("requested_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ account, requests: result.data ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load advance requests.";
    return NextResponse.json({ error: message }, { status: statusCode(message) });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json() as { accountId?: unknown; profileType?: unknown; amount?: unknown; purpose?: unknown };
    const account = await resolveAccount(String(body.accountId ?? ""), String(body.profileType ?? ""));
    if (!account.eligibleForAdvance) {
      throw new Error("Advance requests are available only when Profile status is Active.");
    }
    const amount = Number(body.amount);
    const purpose = String(body.purpose ?? "").trim();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid advance amount.");
    if (amount > 1000000) throw new Error("Advance amount cannot exceed ₹10,00,000.");
    if (purpose.length < 3) throw new Error("Enter the purpose for this advance.");
    if (purpose.length > 500) throw new Error("Purpose must be 500 characters or fewer.");

    const directApprove = await isDirectAdvanceRequester(account.companyId, account.profileType, account.accountId);
    const result = await supabaseAdmin
      .from("payment_advance_requests")
      .insert({
        company_id: account.companyId,
        profile_type: account.profileType,
        account_id: account.accountId,
        account_code: account.accountCode || null,
        requester_name: account.name || null,
        station_code: account.station || null,
        designation: account.designation || null,
        amount,
        purpose,
        status: directApprove ? "approved" : "submitted",
        approved_amount: directApprove ? amount : null,
        decision_comment: directApprove ? "Auto-approved for managing partner / top-level assignment." : null
      })
      .select("id, amount, purpose, status, approved_amount, decision_comment, requested_at, updated_at")
      .single();
    if (result.error) throw new Error(result.error.message);
    await createAppNotification({
      accountId: account.accountId,
      companyId: account.companyId,
      eventCode: directApprove ? "advance_request_approved" : "advance_request_raised",
      profileType: account.profileType,
      sourceKey: String(result.data.id),
      variables: { amount: amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }) }
    });
    return NextResponse.json({
      ok: true,
      request: result.data,
      notice: directApprove ? "Advance request approved." : "Advance request submitted."
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit advance request.";
    return NextResponse.json({ error: message }, { status: statusCode(message) });
  }
}

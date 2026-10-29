import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isAdvanceEligible, validAdvanceApprovalAmount } from "@/lib/advance-eligibility";
import { connectSessionCookieName, normalizeConnectMobile } from "@/lib/connect-auth";
import { createAppNotification } from "@/lib/app-notifications";
import { openPayAdvanceApproval } from "@/lib/payment-advance-approval";
import { loadPayAdvanceCapacity, loadOwnWorkforceAdvanceDeduction } from "@/lib/pay-advance-capacity";
import { sendPaymentAdvanceRequestNotification, sendPaymentAdvanceWithdrawalNotification } from "@/lib/payment-advance-email-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType, type WorkforceProfileType, workforceTable } from "@/lib/workforce-profiles";

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function hasCurrentPeopleAssignment(companyId: string, profileType: WorkforceProfileType, accountId: string) {
  if (!supabaseAdmin) return false;
  if (profileType === "workforce") {
    const worker = await supabaseAdmin.from("workforce").select("id")
      .eq("company_id", companyId).eq("id", accountId).eq("is_active", true)
      .is("deleted_at", null).maybeSingle();
    return !worker.error && Boolean(worker.data);
  }
  if (profileType !== "employee" && profileType !== "contractor") return false;
  const workerColumn = profileType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await supabaseAdmin.from("hr_engagements").select("id")
    .eq("company_id", companyId).eq("worker_type", profileType).eq(workerColumn, accountId).eq("status", "active")
    .limit(1).maybeSingle();
  if (engagement.error || !engagement.data) return false;
  const today = indiaToday();
  const assignment = await supabaseAdmin.from("hr_work_assignments").select("id")
    .eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  return !assignment.error && Boolean(assignment.data);
}

async function resolveAccount(accountId: string, profileType: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (!isWorkforceProfileType(profileType)) throw new Error("Advances are available for workforce accounts only.");
  if (!(["employee", "contractor", "workforce"] as string[]).includes(profileType)) {
    throw new Error("Advance requests are not enabled for this workforce category yet.");
  }

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
  const currentPeopleAssignment = await hasCurrentPeopleAssignment(String(row.company_id), resolvedType, String(row.id));
  const eligibleForAdvance = isAdvanceEligible({
    currentPeopleAssignment,
    profileActive: row.is_active === true,
    profileStatus
  });

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
    locationId: String(row.location_id ?? ""),
    station,
    designation: String("designation" in row ? row.designation ?? "" : "Employee"),
    eligibleForAdvance,
    eligibilitySource: currentPeopleAssignment ? "people" : profileStatus === "active" ? "legacy_profile" : "inactive"
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
    const earningsMonth=request.nextUrl.searchParams.get("earningsMonth");
    if(earningsMonth) {
      if(account.profileType!=="workforce" || !/^\d{4}-\d{2}$/.test(earningsMonth)) throw new Error("Invalid earnings request.");
      return NextResponse.json({advanceRecoveryAmount:await loadOwnWorkforceAdvanceDeduction(account.companyId,account.accountId,earningsMonth)},
        {headers:{"Cache-Control":"private, no-store"}});
    }
    const [result, capacity] = await Promise.all([supabaseAdmin
      .from("hr_pay_advance_requests")
      .select("id, amount:requested_amount, purpose:reason, status, approved_amount, decision_comment:decision_note, requested_at, updated_at")
      .eq("company_id", account.companyId)
      .eq("worker_type", account.profileType)
      .eq("worker_id", account.accountId)
      .order("requested_at", { ascending: false }),
      loadPayAdvanceCapacity({
        companyId: account.companyId,
        profileType: account.profileType as "employee" | "contractor" | "workforce",
        accountId: account.accountId
      })]);
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json({ account: { ...account, ...capacity }, requests: result.data ?? [] });
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
    const capacity = await loadPayAdvanceCapacity({
      companyId: account.companyId,
      profileType: account.profileType as "employee" | "contractor" | "workforce",
      accountId: account.accountId
    });
    if (!validAdvanceApprovalAmount(amount, capacity.maxEligibleAmount)) {
      throw new Error(`Enter an amount up to ₹${capacity.maxEligibleAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}, which is 25% of your currently outstanding pay.`);
    }
    if (purpose.length < 10) throw new Error("Enter a clearer purpose for this advance (at least 10 characters).");
    if (purpose.length > 500) throw new Error("Purpose must be 500 characters or fewer.");

    const created = await openPayAdvanceApproval({
      companyId: account.companyId,
      profileType: account.profileType as "employee" | "contractor" | "workforce",
      accountId: account.accountId, locationId: account.locationId, amount, purpose, ...capacity
    });
    const result = { data: { id: created.requestId, amount, purpose, status: "pending" } };
    await createAppNotification({
      accountId: account.accountId,
      companyId: account.companyId,
      eventCode: "advance_request_raised",
      profileType: account.profileType,
      sourceKey: String(result.data.id),
      variables: { amount: amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }) }
    });
    await sendPaymentAdvanceRequestNotification(account.companyId, String(result.data.id));
    return NextResponse.json({
      ok: true,
      request: result.data,
      notice: "Advance request submitted."
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit advance request.";
    return NextResponse.json({ error: message }, { status: statusCode(message) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json() as { accountId?: unknown; profileType?: unknown; requestId?: unknown };
    const account = await resolveAccount(String(body.accountId ?? ""), String(body.profileType ?? ""));
    const requestId = String(body.requestId ?? "").trim();
    if (!requestId) throw new Error("Advance request is required.");

    const owned = await supabaseAdmin
      .from("hr_pay_advance_requests")
      .select("id, amount:requested_amount")
      .eq("company_id", account.companyId)
      .eq("worker_type", account.profileType)
      .eq("worker_id", account.accountId)
      .eq("id", requestId)
      .in("status", ["pending", "returned"])
      .maybeSingle();
    if (owned.error) throw new Error(owned.error.message);
    if (!owned.data) throw new Error("This request has already been decided and can no longer be withdrawn.");

    const cancelled = await supabaseAdmin.rpc("hr_cancel_pay_advance_request", {
      p_company_id: account.companyId,
      p_payment_advance_request_id: requestId
    });
    if (cancelled.error) throw new Error(cancelled.error.message);
    if (!cancelled.data) throw new Error("This request has already been decided and can no longer be withdrawn.");

    await createAppNotification({
      accountId: account.accountId,
      companyId: account.companyId,
      eventCode: "advance_request_withdrawn",
      profileType: account.profileType,
      sourceKey: requestId,
      variables: { amount: Number(owned.data.amount ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 }) }
    });
    await sendPaymentAdvanceWithdrawalNotification(account.companyId, requestId);

    return NextResponse.json({ ok: true, notice: "Advance request withdrawn." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to withdraw advance request.";
    return NextResponse.json({ error: message }, { status: statusCode(message) });
  }
}

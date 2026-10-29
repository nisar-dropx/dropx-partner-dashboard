import { NextResponse } from "next/server";
import { userFacingError } from "@/lib/user-facing-error";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { loadApprovalJourneySteps, type ApprovalJourneyStep } from "../../../../src/lib/connect-approval-journey";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedAdvanceText(value: unknown) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function legacyAdvanceReference(id: unknown) {
  const compact = clean(id).replace(/[^a-z0-9]/gi, "").slice(0, 10).toUpperCase();
  return compact ? `ADV-${compact}` : "ADV-LEGACY";
}

function isSameAdvanceSubmission(
  legacy: { amount?: unknown; purpose?: unknown; requested_at?: unknown },
  payroll: { requested_amount?: unknown; reason?: unknown; requested_at?: unknown }
) {
  const legacyTime = new Date(clean(legacy.requested_at)).getTime();
  const payrollTime = new Date(clean(payroll.requested_at)).getTime();
  return Number.isFinite(legacyTime) && Number.isFinite(payrollTime)
    && Math.abs(legacyTime - payrollTime) <= 5_000
    && Math.abs(Number(legacy.amount) - Number(payroll.requested_amount)) < 0.01
    && normalizedAdvanceText(legacy.purpose) === normalizedAdvanceText(payroll.reason);
}

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

async function accountFromRequest(url: URL) {
  const accountId = clean(url.searchParams.get("accountId"));
  const profileType = clean(url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
  return account;
}

// Eligibility and writes must use the same canonical advance service. This
// endpoint additionally provides the approval journey used by My Requests.
const dashboardUrl = process.env.DASHBOARD_URL?.replace(/\/$/, "") || "https://dashboard.dropxlogistics.com";

async function advanceService(request: Request, method: "GET" | "POST" | "PATCH") {
  const target = new URL("/api/connect/advances", dashboardUrl);
  new URL(request.url).searchParams.forEach((value, key) => target.searchParams.set(key, value));
  return fetch(target, {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { cookie: request.headers.get("cookie") ?? "", "content-type": "application/json" },
    body: method === "GET" ? undefined : await request.text()
  });
}

async function mutate(request: Request, method: "POST" | "PATCH") {
  try {
    const body = await request.clone().json();
    const account = await requireConnectAccount(body.profileType, clean(body.accountId));
    if (account.profileType === "user" || !account.pageAccess.includes("advances")) {
      return NextResponse.json({ error: "Advance requests are not enabled for this account." }, { status: 403 });
    }
    const response = await advanceService(request, method);
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" }
    });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to update advance request.") }, { status: 400 });
  }
}

export function POST(request: Request) { return mutate(request, "POST"); }
export function PATCH(request: Request) { return mutate(request, "PATCH"); }

function ownerReviewStatus(status: string) {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "returned") return "returned";
  if (status === "cancelled" || status === "closed") return "skipped";
  return "pending";
}

export async function GET(request: Request) {
  try {
    const account = await accountFromRequest(new URL(request.url));
    const workerType = account.profileType === "employee" || account.profileType === "contractor" || account.profileType === "workforce"
      ? account.profileType
      : null;

    const paymentResult = await db().from("payment_advance_requests")
      .select("id,amount,purpose,status,approved_amount,decision_comment,requested_at,updated_at")
      .eq("company_id", account.companyId)
      .eq("account_id", account.id)
      .order("requested_at", { ascending: false })
      .limit(50);
    if (paymentResult.error && !/does not exist|schema cache/i.test(paymentResult.error.message)) {
      throw new Error(paymentResult.error.message);
    }

    let eligibleForAdvance = false;
    let capacity = { outstandingPay: 0, committedAdvance: 0, eligibilityPercent: 25, maxEligibleAmount: 0, breakdown: [] };
    if (account.profileType !== "user" && account.pageAccess.includes("advances")) {
      const response = await advanceService(request, "GET");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to check advance eligibility.");
      if (typeof payload.account?.eligibleForAdvance !== "boolean") {
        throw new Error("Unable to verify advance eligibility. Please retry shortly.");
      }
      eligibleForAdvance = payload.account.eligibleForAdvance;
      capacity = {
        outstandingPay: Number(payload.account.outstandingPay ?? 0),
        committedAdvance: Number(payload.account.committedAdvance ?? 0),
        eligibilityPercent: Number(payload.account.eligibilityPercent ?? 25),
        maxEligibleAmount: Number(payload.account.maxEligibleAmount ?? 0),
        breakdown: Array.isArray(payload.account.breakdown) ? payload.account.breakdown : []
      };
    }

    const payrollResult = workerType
      ? await db().from("hr_pay_advance_requests")
        .select("id,request_number,requested_amount,approved_amount,outstanding_pay_snapshot,eligibility_percent_snapshot,max_eligible_amount_snapshot,reason,status,requested_at,updated_at,decision_note,recovery_mode,requested_installments,external_source,external_reference")
        .eq("company_id", account.companyId)
        .eq("worker_type", workerType)
        .eq("worker_id", account.id)
        .order("requested_at", { ascending: false })
        .limit(50)
      : { data: [], error: null };
    if (payrollResult.error && !/does not exist|schema cache/i.test(payrollResult.error.message)) {
      throw new Error(payrollResult.error.message);
    }

    const payrollRows = payrollResult.data ?? [];
    const journeys = await loadApprovalJourneySteps(account.companyId, payrollRows.map((row) => row.id), {
      table: "hr_pay_advance_steps",
      parentColumn: "request_id",
      orderColumn: "step_order",
      labelColumn: "step_name",
      actorColumns: ["approver_user_id"],
      actedAtColumn: "decided_at",
      noteColumn: "decision_note"
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (/does not exist|schema cache/i.test(message)) return new Map<string, ApprovalJourneyStep[]>();
      throw error;
    });

    const linkedPaymentIds = new Set(payrollRows.filter((row) => row.external_source === "payment_advance_requests")
      .map((row) => String(row.external_reference ?? "")).filter(Boolean));
    // Requests created during the legacy-to-payroll cutover can have both rows but no
    // external_reference. Treat the identical account/amount/reason/timestamp pair as
    // one request so DropX One never shows a second, stale "Owner review" card.
    for (const paymentRow of paymentResult.data ?? []) {
      if (payrollRows.some((payrollRow) => isSameAdvanceSubmission(paymentRow, payrollRow))) {
        linkedPaymentIds.add(String(paymentRow.id));
      }
    }
    const requests = [
      ...(paymentResult.data ?? []).filter((row) => !linkedPaymentIds.has(String(row.id))).map((row) => ({
        id: row.id,
        source: "ops",
        reference: legacyAdvanceReference(row.id),
        purpose: row.purpose,
        approved_amount: row.approved_amount,
        decision_comment: row.decision_comment,
        requested_at: row.requested_at,
        updated_at: row.updated_at,
        canWithdraw: ["submitted", "in_review"].includes(row.status),
        title: row.purpose || "Advance request",
        amount: Number(row.amount),
        approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
        status: row.status,
        requestedAt: row.requested_at,
        note: row.decision_comment,
        steps: [
          { stepName: "Submitted", status: "approved", note: null },
          { stepName: "Owner review", status: ownerReviewStatus(String(row.status)), note: row.decision_comment }
        ]
      })),
      ...payrollRows.map((row) => ({
        id: row.id,
        source: "payroll",
        reference: row.request_number,
        purpose: row.reason,
        approved_amount: row.approved_amount,
        decision_comment: row.decision_note,
        requested_at: row.requested_at,
        updated_at: row.updated_at ?? row.requested_at,
        canWithdraw: false,
        title: row.request_number || row.reason || "Pay advance",
        amount: Number(row.requested_amount),
        approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
        outstandingPay: row.outstanding_pay_snapshot == null ? null : Number(row.outstanding_pay_snapshot),
        eligibilityPercent: Number(row.eligibility_percent_snapshot ?? 25),
        maxEligibleAmount: Number(row.max_eligible_amount_snapshot ?? row.requested_amount),
        status: row.status,
        requestedAt: row.requested_at,
        note: row.decision_note,
        recovery: row.recovery_mode,
        installments: row.requested_installments,
        steps: (journeys.get(row.id) ?? []).map((step: ApprovalJourneyStep) => ({
          stepName: step.label.toLowerCase().includes("finance")
            ? `Finance · ${step.label}`
            : step.actorName ? `${step.actorName} · ${step.label}` : step.label,
          status: step.status,
          note: step.note
        }))
      }))
    ];

    return NextResponse.json({ account: { eligibleForAdvance, ...capacity }, requests }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load advances.") }, { status: 400 });
  }
}

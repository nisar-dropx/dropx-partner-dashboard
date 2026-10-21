import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  requireConnectAccount,
  type ConnectAccount,
} from "../../../../src/lib/connect-auth";

export const dynamic = "force-dynamic";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Database is not configured.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function recoveryRef(profileType: string, accountId: string) {
  return profileType === "workforce"
    ? `workforce:${accountId}`
    : `employee:${accountId}`;
}

async function boundAccount(accountId: string, profileType: string) {
  if (
    !accountId ||
    !["employee", "workforce", "contractor", "field_executive"].includes(profileType)
  ) {
    throw new Error("Choose a valid account.");
  }
  // Bind accountId to the Connect login session (same pattern as leave/proof routes).
  return requireConnectAccount(
    profileType as ConnectAccount["profileType"],
    accountId,
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const account = await boundAccount(
      url.searchParams.get("accountId") || "",
      url.searchParams.get("profileType") || "",
    );
    const profileType = account.profileType;
    const accountId = account.id;
    const ref = recoveryRef(profileType, accountId);
    const client = db();
    const company = account.companyId;
    const ledger = await client.rpc("nl_recovery_ledger", {
      p_company: company,
      p_from_month: null,
      p_ref: ref,
    });
    if (ledger.error) {
      if (/does not exist|schema cache/i.test(ledger.error.message)) {
        return NextResponse.json({ recoveries: [] });
      }
      throw new Error(ledger.error.message);
    }
    const rows = (ledger.data ?? []).filter(
      (r: any) => Number(r.outstanding) > 0 || r.status === "in_progress" || r.status === "scheduled",
    );
    const recoveries = [];
    for (const row of rows) {
      const caseRow = await client
        .from("nl_loss_month_cases")
        .select("source_status,details,lifecycle_status,report,station_code")
        .eq("company_id", company)
        .eq("month", row.month)
        .eq("case_key", row.case_key)
        .maybeSingle();
      const plan = await client
        .from("nl_loss_recoveries")
        .select("deduction_month,recovery_mode,approval_status,cap_override")
        .eq("company_id", company)
        .eq("month", row.month)
        .eq("case_key", row.case_key)
        .maybeSingle();
      // Only SLP-approved plans are payroll-due; hide proposals until locked.
      if (plan.data && plan.data.approval_status !== "approved") continue;
      recoveries.push({
        month: row.month,
        caseKey: row.case_key,
        report: row.report,
        stationCode: row.station_code,
        reason:
          caseRow.data?.details?.category ||
          caseRow.data?.source_status ||
          row.outcome_label ||
          "Loss recovery",
        assignedAmount: Number(row.total),
        recoveryMode: row.recovery_mode,
        installmentCount: row.installment_count,
        monthlyAmount: Number(row.monthly_amount),
        deducted: Number(row.deducted),
        outstanding: Number(row.outstanding),
        status: row.status,
        lifecycleStatus: caseRow.data?.lifecycle_status ?? null,
        nextDueMonth: plan.data?.deduction_month ?? row.first_salary_month,
        capOverride: Boolean(row.cap_override || plan.data?.cap_override),
        finalSettlement: row.status === "exit_balance",
        approvalStatus: plan.data?.approval_status ?? null,
      });
    }
    return NextResponse.json(
      { recoveries },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unable to load loss recoveries." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
    }
    const body = await request.json();
    const account = await boundAccount(
      String(body.accountId || ""),
      String(body.profileType || ""),
    );
    const accountId = account.id;
    const profileType = account.profileType;
    const month = String(body.month || "");
    const caseKey = String(body.caseKey || "");
    const note = String(body.note || "").trim();
    if (!month || !caseKey || note.length < 10) {
      return NextResponse.json({ error: "Case, month and a note (10+ characters) are required." }, { status: 400 });
    }
    const ref = recoveryRef(profileType, accountId);
    const client = db();
    // Ensure the associate is allocated on an approved plan before accepting a clarification.
    const ledger = await client.rpc("nl_recovery_ledger", {
      p_company: account.companyId,
      p_from_month: month,
      p_ref: ref,
    });
    const mine = (ledger.data ?? []).some(
      (r: any) => r.month === month && r.case_key === caseKey,
    );
    if (!mine) {
      return NextResponse.json({ error: "This recovery is not assigned to you." }, { status: 403 });
    }
    const plan = await client
      .from("nl_loss_recoveries")
      .select("approval_status,is_deleted")
      .eq("company_id", account.companyId)
      .eq("month", month)
      .eq("case_key", caseKey)
      .maybeSingle();
    if (!plan.data || plan.data.is_deleted || plan.data.approval_status !== "approved") {
      return NextResponse.json(
        { error: "This recovery is not yet confirmed for payroll." },
        { status: 403 },
      );
    }
    const { data, error } = await client.rpc("nl_loss_clarification_submit", {
      p_company: account.companyId,
      p_month: month,
      p_case: caseKey,
      p_actor: accountId,
      p_name: account.name || "Associate",
      p_note: note,
      p_reason: String(body.reason || "Associate clarification"),
      p_category: String(body.category || "clarification"),
      p_employee_ref: ref,
      p_evidence_url: body.evidenceUrl || null,
      p_attachments: [],
      p_source: "associate",
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, clarification: data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unable to submit clarification." },
      { status: 400 },
    );
  }
}

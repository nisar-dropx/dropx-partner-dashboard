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
  return `${profileType === "workforce" ? "workforce" : profileType === "contractor" ? "contractor" : "employee"}:${accountId}`;
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

function tidFromCase(caseKey: string, details: Record<string, unknown> | null | undefined) {
  const fromDetails = typeof details?.tid === "string" ? details.tid.trim() : "";
  if (fromDetails) return fromDetails;
  return String(caseKey || "").replace(/^slp:/i, "");
}

function myAllocation(
  allocations: unknown,
  ref: string,
): { amount: number; monthlyAmount: number | null; installmentNo: number | null; installmentCount: number | null } | null {
  if (!Array.isArray(allocations)) return null;
  const mine = allocations.find((row) => row && typeof row === "object" && (row as { ref?: string }).ref === ref) as
    | {
        amount?: number | string;
        monthly_amount?: number | string | null;
        installment_no?: number | string | null;
        installment_count?: number | string | null;
      }
    | undefined;
  if (!mine) return null;
  return {
    amount: Number(mine.amount) || 0,
    monthlyAmount: mine.monthly_amount == null ? null : Number(mine.monthly_amount) || 0,
    installmentNo: mine.installment_no == null ? null : Number(mine.installment_no) || null,
    installmentCount: mine.installment_count == null ? null : Number(mine.installment_count) || null,
  };
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
    // Keep completed deductions visible, and never widen the session-bound person's scope.
    const requestedMonth = url.searchParams.get("month");
    const requestedCase = url.searchParams.get("caseKey");
    const rows = (ledger.data ?? []).filter(
      (r: { employee_ref?: string; month?: string; case_key?: string }) =>
        r.employee_ref === ref && (!requestedMonth || r.month === requestedMonth)
        && (!requestedCase || r.case_key === requestedCase),
    );
    const debitRows = await client.rpc("nl_recovery_debits", {p_company:company,p_ref:ref});
    if(debitRows.error) throw new Error("Your deduction history could not be loaded. Please retry.");
    const ownDebits=(debitRows.data ?? []).filter((r: {employee_ref:string})=>r.employee_ref===ref);
    const questions = await client.from("nl_loss_clarifications").select("month,case_key,note,status,decision_note,decided_by_name,created_at").eq("company_id",company).eq("employee_ref",ref).order("created_at",{ascending:false}).limit(500);
    if(questions.error)throw Error("Your recovery questions could not be loaded.");
    const recoveries = [];
    for (const row of rows) {
      const caseRow = await client
        .from("nl_loss_month_cases")
        .select("source_status,details,lifecycle_status,report,station_code,amount")
        .eq("company_id", company)
        .eq("month", row.month)
        .eq("case_key", row.case_key)
        .maybeSingle();
      const plan = await client
        .from("nl_loss_recoveries")
        .select(
          "deduction_month,recovery_mode,approval_status,cap_override,outcome_label,remarks,allocations,installment_basis,installment_value,source_amount",
        )
        .eq("company_id", company)
        .eq("month", row.month)
        .eq("case_key", row.case_key)
        .maybeSingle();
      // A person may see their assigned proposal, clearly distinguished from a confirmed debit.
      if (caseRow.error) throw new Error("Unable to load the loss case. Please retry.");
      if (plan.error) throw new Error("Unable to load the recovery plan. Please retry.");
      // Retain payroll history even if a later source change pauses the remaining plan.
      if (!plan.data) continue;
      const details = (caseRow.data?.details ?? {}) as Record<string, unknown>;
      const share = myAllocation(plan.data?.allocations, ref);
      recoveries.push({
        clarifications: (questions.data||[]).filter(q=>q.month===row.month && q.case_key===row.case_key),
        month: row.month,
        caseKey: row.case_key,
        tid: tidFromCase(row.case_key, details),
        tidApproximate: details.tid_approximate === true,
        report: row.report,
        stationCode: row.station_code,
        reason:
          (typeof details.category === "string" && details.category) ||
          caseRow.data?.source_status ||
          row.outcome_label ||
          "Loss recovery",
        category: typeof details.category === "string" ? details.category : null,
        subCategory: typeof details.sub_category === "string" ? details.sub_category : null,
        impactDate: typeof details.impact_date === "string" ? details.impact_date : null,
        period: typeof details.period === "string" ? details.period : null,
        remarks:
          (typeof details.remarks === "string" && details.remarks) ||
          plan.data?.remarks ||
          null,
        daName: typeof details.da_name === "string" ? details.da_name : null,
        caseAmount: Number(caseRow.data?.amount ?? row.total) || 0,
        assignedAmount: Number(row.total),
        myShareAmount: share?.amount ?? Number(row.total),
        recoveryMode: row.recovery_mode,
        installmentCount: row.installment_count ?? share?.installmentCount ?? null,
        monthlyAmount: Number(row.monthly_amount ?? share?.monthlyAmount ?? 0),
        deducted: Number(row.deducted),
        inPayroll: Number(row.in_payroll) || 0,
        waived: Number(row.waived) || 0,
        lastDeductedMonth: row.last_deducted_in ?? null,
        outstanding: Number(row.outstanding),
        status: row.status?.startsWith("redispute_") ? row.status : plan.data.approval_status !== "approved" ? "awaiting_approval" : row.status,
        lifecycleStatus: caseRow.data?.lifecycle_status ?? null,
        scheduledFromMonth: row.first_salary_month ?? plan.data?.deduction_month,
        capOverride: Boolean(row.cap_override || plan.data?.cap_override),
        finalSettlement: row.status === "exit_balance",
        approvalStatus: plan.data?.approval_status ?? null,
        outcomeLabel: plan.data?.outcome_label ?? row.outcome_label ?? null,
        deductions: ownDebits.filter((d: {loss_month:string;case_key:string})=>d.loss_month===row.month && d.case_key===row.case_key).map((d: {recovery_key:string;payroll_month:string;amount:number;is_deducted:boolean})=>({key:d.recovery_key,month:d.payroll_month,amount:Number(d.amount),confirmed:d.is_deducted})),
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
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !caseKey || note.length < 10 || note.length > 4000) {
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
      (r: { month?: string; case_key?: string }) => r.month === month && r.case_key === caseKey,
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

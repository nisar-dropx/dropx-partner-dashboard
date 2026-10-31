import {loadCurrentAdvanceCapacity} from "./connect-advance-context";
import "server-only";
import type { ConnectAccount } from "./connect-auth";
import { loadConnectApprovalLocations } from "./connect-approval-location";
import {
  adoptPendingStepForHigherManager,
  resolveConnectActorUserIds,
  resolveConnectVisibleApproverUserIds
} from "./connect-approver-identity";
import { payAdvanceApprovalPayContext, payAdvanceDecision, payAdvanceFinanceTerms, type PayAdvanceApproval, type PayAdvanceReviewDetails } from "./connect-pay-advance-approval";
import { supabaseAdmin } from "./supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }

async function mapPayAdvanceRows(
  companyId: string,
  steps: Array<{ id: string; request_id: string; step_name: string; step_type: string }>,
  requests: Array<Record<string, unknown>>
): Promise<PayAdvanceApproval[]> {
  const month = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(new Date()) + "-01";
  const locations = await loadConnectApprovalLocations(
    companyId,
    requests.map((row) => ({ profileType: String(row.worker_type ?? ""), profileId: String(row.worker_id ?? "") }))
  );
  return Promise.all(requests.map(async (row) => {
    const result = await db().rpc("pay_advance_worker_summary", {
      p_company: companyId, p_worker_type: row.worker_type, p_worker: row.worker_id, p_month: month
    });
    if (result.error) throw new Error("Unable to verify the worker's paid advance history. Please retry.");
    const history = result.data;
    const live = await loadCurrentAdvanceCapacity(companyId,String(row.id));
    const step = steps.find((item) => item.request_id === row.id)!;
    const pay = payAdvanceApprovalPayContext(row.worker_type, row.requested_amount, row.outstanding_pay_snapshot,
      row.eligibility_percent_snapshot, row.max_eligible_amount_snapshot);
    const location = locations.get(`${String(row.worker_type)}:${String(row.worker_id)}`);
    return {
      id: step.id,
      requestId: String(row.id),
      requestNumber: String(row.request_number),
      workerName: String(row.worker_name),
      workerCode: String(row.worker_code ?? ""),
      stationCode: location?.stationCode ?? "",
      stationName: location?.stationName ?? "",
      stepName: step.step_name,
      stepType: step.step_type,
      requestedAmount: Number(row.requested_amount),
      approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
      ...pay,
      outstandingPay:live.outstandingPay,
      maxEligibleAmount:Math.min(live.maxEligibleAmount,Number(row.max_eligible_amount_snapshot??row.requested_amount)),
      monthPaidCount: Number(history.monthPaidCount), monthPaidAmount: Number(history.monthPaidAmount),
      outstandingAdvance: Number(history.outstandingAdvance), reservedRecovery: Number(history.reservedRecovery),
      recoveryMode: String(row.recovery_mode),
      installments: Number(row.approved_installments ?? row.requested_installments),
      reason: String(row.reason),
      neededBy: row.needed_by == null ? null : String(row.needed_by)
    };
  }));
}

const REQUEST_SELECT = "id,request_number,worker_type,worker_id,worker_name,worker_code,requested_amount,approved_amount,outstanding_pay_snapshot,eligibility_percent_snapshot,max_eligible_amount_snapshot,recovery_mode,requested_installments,approved_installments,reason,needed_by";

async function allReviewRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 500) {
    const result = await page(from, from + 499);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 500) return rows;
  }
}

/** Recheck the pending assignment before exposing another worker's pay/history. */
export async function loadConnectPayAdvanceReviewDetails(account: ConnectAccount, requestId: string): Promise<PayAdvanceReviewDetails> {
  const visible = await resolveConnectVisibleApproverUserIds(account);
  if (!visible.length) throw new Error("This advance is not assigned to you or your reporting line.");
  const assigned = await db().from("hr_pay_advance_steps").select("id,step_type")
    .eq("company_id", account.companyId).eq("request_id", requestId).eq("status", "pending")
    .in("approver_user_id", visible).limit(1).maybeSingle();
  if (assigned.error) throw new Error(assigned.error.message);
  if (!assigned.data) throw new Error("This advance is not assigned to you or is no longer pending.");
  const request = await db().from("hr_pay_advance_requests")
    .select("worker_type,worker_id,worker_name,requested_at,requested_by,requested_amount,max_eligible_amount_snapshot")
    .eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending").maybeSingle();
  if (request.error) throw new Error(request.error.message);
  if (!request.data) throw new Error("This advance is no longer pending.");
  const row = request.data;
  const [capacity, steps, advances] = await Promise.all([
    loadCurrentAdvanceCapacity(account.companyId, requestId),
    allReviewRows((from, to) => db().from("hr_pay_advance_steps")
      .select("id,step_order,step_name,status,approver_user_id,approved_amount,decision_note,decided_at")
      .eq("company_id", account.companyId).eq("request_id", requestId).order("step_order").order("id").range(from, to)),
    allReviewRows((from, to) => db().from("pay_advances")
      .select("id,amount,paid_at,first_due_period,installments,evidence_type,bank_reference,provenance,request_id")
      .eq("company_id", account.companyId).eq("worker_type", row.worker_type).eq("worker_id", row.worker_id)
      .order("paid_at", { ascending: false }).order("id").range(from, to))
  ]);
  const actors = [...new Set([row.requested_by, ...steps.map(s => s.approver_user_id)].filter(Boolean))];
  const profiles = actors.length ? await db().from("profiles").select("id,full_name")
    .eq("company_id", account.companyId).in("id", actors) : { data: [], error: null };
  if (profiles.error) throw new Error(profiles.error.message);
  const names = new Map((profiles.data ?? []).map(p => [p.id, p.full_name]));
  const deductions: Array<{ id: string; advance_id: string; period_start: string; amount: number | string; status: string; target_kind: string }> = [];
  for (let start = 0; start < advances.length; start += 100) {
    deductions.push(...await allReviewRows((from, to) => db().from("pay_advance_deductions")
      .select("id,advance_id,period_start,amount,status,target_kind")
      .eq("company_id", account.companyId).in("advance_id", advances.slice(start, start + 100).map(a => a.id))
      .order("period_start").order("id").range(from, to)));
  }
  // Request numbers are not guaranteed in provenance for payments recorded after cutover.
  const requestRefs = await allReviewRows((from, to) => db().from("hr_pay_advance_requests").select("id,request_number")
    .eq("company_id", account.companyId).eq("worker_type", row.worker_type).eq("worker_id", row.worker_id)
    .order("id").range(from, to));
  const refs = new Map(requestRefs.map(r => [r.id, r.request_number]));
  return {
    requestedAt: row.requested_at, submittedBy: names.get(row.requested_by) || row.worker_name,
    steps: steps.map(s => ({ id: s.id, label: s.step_name, status: s.status, actorName: names.get(s.approver_user_id) || null,
      actedAt: s.decided_at, note: s.decision_note, approvedAmount: s.approved_amount == null ? null : Number(s.approved_amount) })),
    capacity, requestLimit: Math.min(capacity.maxEligibleAmount, Number(assigned.data.step_type === "finance"
      ? row.max_eligible_amount_snapshot ?? row.requested_amount : row.requested_amount)),
    advances: advances.map(a => {
      const lines = deductions.filter(d => d.advance_id === a.id);
      const sum = (status: string) => lines.filter(d => d.status === status).reduce((total, d) => total + Number(d.amount), 0);
      const recovered = sum("confirmed"), reserved = sum("reserved"), waived = sum("waived");
      return { id: a.id, reference: refs.get(a.request_id) || a.provenance?.request_number || a.provenance?.advance_number || "Recorded advance",
        amount: Number(a.amount), paidAt: a.paid_at, firstDuePeriod: a.first_due_period, installments: Number(a.installments),
        evidence: a.evidence_type, bankReference: a.bank_reference, recovered, reserved, waived,
        outstanding: Math.round((Number(a.amount) - recovered - waived) * 100) / 100,
        deductions: lines.map(d => ({ id: d.id, period: d.period_start, amount: Number(d.amount), status: d.status, target: d.target_kind })) };
    })
  };
}

/** Only steps assigned to this login — not subordinates' queues. */
export async function listConnectPayAdvanceApprovals(account: ConnectAccount): Promise<PayAdvanceApproval[]> {
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) return [];
  const steps = await db().from("hr_pay_advance_steps").select("id,request_id,step_name,step_type")
    .eq("company_id", account.companyId).in("approver_user_id", actorIds).eq("status", "pending").order("created_at");
  if (steps.error) throw new Error(steps.error.message);
  if (!steps.data?.length) return [];
  const requests = await db().from("hr_pay_advance_requests")
    .select(REQUEST_SELECT)
    .eq("company_id", account.companyId).eq("status", "pending").in("id", steps.data.map((step) => step.request_id));
  if (requests.error) throw new Error(requests.error.message);
  return mapPayAdvanceRows(account.companyId, steps.data, requests.data ?? []);
}

/**
 * Pending advances assigned to people below this manager on the reporting line.
 * Shown only under All team (not the assigned list), but still actionable.
 */
export async function listConnectPayAdvanceOversight(account: ConnectAccount): Promise<PayAdvanceApproval[]> {
  const [selfIds, visibleIds] = await Promise.all([
    resolveConnectActorUserIds(account),
    resolveConnectVisibleApproverUserIds(account)
  ]);
  const self = new Set(selfIds);
  const below = visibleIds.filter((id) => !self.has(id));
  if (!below.length) return [];
  const steps = await db().from("hr_pay_advance_steps").select("id,request_id,step_name,step_type")
    .eq("company_id", account.companyId).in("approver_user_id", below).eq("status", "pending").order("created_at");
  if (steps.error) throw new Error(steps.error.message);
  if (!steps.data?.length) return [];
  const requests = await db().from("hr_pay_advance_requests")
    .select(REQUEST_SELECT)
    .eq("company_id", account.companyId).eq("status", "pending").in("id", steps.data.map((step) => step.request_id));
  if (requests.error) throw new Error(requests.error.message);
  return mapPayAdvanceRows(account.companyId, steps.data, requests.data ?? []);
}

export async function decideConnectPayAdvanceApproval(account: ConnectAccount, requestId: string, action: unknown, note: unknown, amount?: unknown, installments?: unknown) {
  const decision = payAdvanceDecision(action, note);
  const actorIds = await resolveConnectActorUserIds(account);
  if (!actorIds.length) throw new Error("This pay advance is not assigned to your account.");
  // Higher managers may act from All team: adopt the subordinate's pending step first.
  await adoptPendingStepForHigherManager({
    companyId: account.companyId,
    actorUserId: actorIds[0],
    table: "hr_pay_advance_steps",
    parentColumn: "request_id",
    parentId: requestId
  });
  const pending = await db().from("hr_pay_advance_steps").select("step_type,approver_user_id")
    .eq("company_id", account.companyId).eq("request_id", requestId).eq("status", "pending")
    .in("approver_user_id", actorIds).order("step_order").limit(1).maybeSingle();
  if (pending.error) throw new Error(pending.error.message);
  const step = pending.data;
  if (!step) throw new Error("This pay advance is not assigned to you or is no longer pending.");
  let terms: ReturnType<typeof payAdvanceFinanceTerms> | null = null;
  if (decision.decision === "approved") {
    const request = await db().from("hr_pay_advance_requests").select("requested_amount,max_eligible_amount_snapshot,requested_installments")
      .eq("company_id", account.companyId).eq("id", requestId).eq("status", "pending").maybeSingle();
    if (request.error) throw new Error(request.error.message);
    if (!request.data) throw new Error("This pay advance is no longer pending.");
    const live = await loadCurrentAdvanceCapacity(account.companyId,requestId);
    const snapshotMaximum = step.step_type === "finance"
      ? Number(request.data.max_eligible_amount_snapshot ?? request.data.requested_amount)
      : Number(request.data.requested_amount);
    terms = payAdvanceFinanceTerms(
      amount,
      step.step_type === "finance" ? installments : request.data.requested_installments,
      Math.min(snapshotMaximum,live.maxEligibleAmount)
    );
  }
  const result = await db().rpc("hr_decide_pay_advance_step", {
    p_company_id: account.companyId, p_request_id: requestId, p_actor_user_id: step.approver_user_id,
    p_decision: decision.decision, p_note: decision.note, p_approved_amount: terms?.approvedAmount ?? null, p_approved_installments: terms?.approvedInstallments ?? null
  });
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

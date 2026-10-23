import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import { mapWithConcurrency } from "@/lib/bounded-concurrency";
import { loadHelperPayoutRows } from "@/lib/helper-payout-loader";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import {
  payableBalanceMonthRange,
  payableBalanceMonthSequence,
  peoplePayrollFinalPayable,
  reconcilePayableBalance,
  roundPayableMoney,
  type PayableBalancePayment,
  type PayableBalanceTarget
} from "@/lib/payable-balance";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadStablePayoutWorksheet } from "@/lib/stable-payout-worksheet";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";
const PEOPLE_RUN_STATUSES = ["calculated", "reviewed", "approved", "locked"];

type MonthRows = {
  targets: PayableBalanceTarget[];
  payments: PayableBalancePayment[];
  error: string | null;
};

export type PayableBalanceLoadResult = {
  months: string[];
  grains: ReturnType<typeof reconcilePayableBalance>;
  error: string | null;
};

function canSeeAllLocations(authorization: AuthorizationContext) {
  return authorization.hasAllLocationAccess || authorization.isMasterOwner;
}

function scopedLocationIds(authorization: AuthorizationContext) {
  return authorization.locationScopeIds.length ? authorization.locationScopeIds : [EMPTY_SCOPE];
}

function monthFromDate(value: unknown) {
  const month = String(value ?? "").slice(0, 7);
  return payableBalanceMonthRange(month) ? month : null;
}

function identity(...values: unknown[]) {
  return values.map((value) => String(value ?? "").trim().toLowerCase()).join("|");
}

function sourceError(source: string, message: string) {
  return `${source}: ${message}`;
}

async function loadAvailableMonths(
  companyId: string,
  authorization: AuthorizationContext
): Promise<{ months: string[]; error: string | null }> {
  if (!supabaseAdmin) return { months: [], error: "Database connection is not configured." };

  const allLocations = canSeeAllLocations(authorization);
  let reviewQuery = supabaseAdmin
    .from("workforce_payout_review_submissions")
    .select("period_start,location_id")
    .eq("company_id", companyId)
    .in("subject_type", ["workforce", "helper"])
    .order("period_start");
  let workforceHistoryQuery = supabaseAdmin
    .from("workforce_payout_payment_items")
    .select("period_start,location_id_snapshot")
    .eq("company_id", companyId)
    .order("period_start");
  let helperHistoryQuery = supabaseAdmin
    .from("helper_payout_payment_items")
    .select("period_start,location_id_snapshot")
    .eq("company_id", companyId)
    .order("period_start");
  if (!allLocations) {
    const locationIds = scopedLocationIds(authorization);
    reviewQuery = reviewQuery.in("location_id", locationIds);
    workforceHistoryQuery = workforceHistoryQuery.in("location_id_snapshot", locationIds);
    helperHistoryQuery = helperHistoryQuery.in("location_id_snapshot", locationIds);
  }

  const [runs, reviews, workforceHistory, helperHistory] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("hr_payroll_runs")
      .select("period_start")
      .eq("company_id", companyId)
      .in("status", PEOPLE_RUN_STATUSES)
      .order("period_start")),
    readAllRows(reviewQuery),
    readAllRows(workforceHistoryQuery),
    readAllRows(helperHistoryQuery)
  ]);
  const error = runs.error?.message || reviews.error?.message
    || workforceHistory.error?.message || helperHistory.error?.message;
  if (error) return { months: [], error };

  const currentMonth = todayKolkata().slice(0, 7);
  const months = new Set<string>([currentMonth]);
  for (const row of [
    ...(runs.data ?? []),
    ...(reviews.data ?? []),
    ...(workforceHistory.data ?? []),
    ...(helperHistory.data ?? [])
  ]) {
    const month = monthFromDate(row.period_start);
    if (month) months.add(month);
  }
  // Recalculate every calendar month from the first observed payroll/payout
  // month through today. This prevents an unpaid month with no review or bank
  // attempt from disappearing between two months that do have history.
  const earliestMonth = [...months].sort()[0];
  for (const month of payableBalanceMonthSequence(earliestMonth, currentMonth)) months.add(month);
  return { months: [...months].sort((left, right) => right.localeCompare(left)), error: null };
}

async function loadPeoplePayrollMonth(
  companyId: string,
  authorization: AuthorizationContext,
  month: string
): Promise<MonthRows> {
  if (!supabaseAdmin) return { targets: [], payments: [], error: "Database connection is not configured." };
  const range = payableBalanceMonthRange(month);
  if (!range) return { targets: [], payments: [], error: "Choose a valid payroll month." };

  const runResult = await supabaseAdmin
    .from("hr_payroll_runs")
    .select("id,period_start,period_end,status")
    .eq("company_id", companyId)
    .eq("period_start", range.start)
    .eq("period_end", range.end)
    .in("status", PEOPLE_RUN_STATUSES)
    .maybeSingle();
  if (runResult.error) return { targets: [], payments: [], error: runResult.error.message };
  if (!runResult.data) return { targets: [], payments: [], error: null };

  let peopleQuery = supabaseAdmin
    .from("hr_payroll_run_people")
    .select("id,run_id,worker_type,worker_id,location_id,net_pay,adjusted_net_pay,hr_payroll_run_items(code,item_type,amount,metadata)")
    .eq("company_id", companyId)
    .eq("run_id", runResult.data.id)
    .order("id");
  if (!canSeeAllLocations(authorization)) {
    peopleQuery = peopleQuery.in("location_id", scopedLocationIds(authorization));
  }
  const [peopleResult, linesResult] = await Promise.all([
    readAllRows(peopleQuery),
    readAllRows(supabaseAdmin
      .from("hr_payroll_bank_lines")
      .select("id,run_id,worker_type,worker_id,amount,status")
      .eq("company_id", companyId)
      .eq("run_id", runResult.data.id)
      .eq("status", "paid")
      .order("id"))
  ]);
  const error = peopleResult.error?.message || linesResult.error?.message;
  if (error) return { targets: [], payments: [], error };

  const peopleByWorker = new Map<string, { identity: string; target: number }>();
  const targets: PayableBalanceTarget[] = [];
  for (const person of peopleResult.data ?? []) {
    const workerKey = identity(person.run_id, person.worker_type, person.worker_id);
    const grainIdentity = identity(person.run_id, person.worker_type, person.worker_id, person.location_id ?? "unassigned");
    const target = peoplePayrollFinalPayable(person);
    peopleByWorker.set(workerKey, { identity: grainIdentity, target });
    // Keep a known zero target so reconciliation can distinguish it from a
    // historical paid row whose original target is no longer available.
    targets.push({ source: "people_payroll", month, identity: grainIdentity, targetAmount: target });
  }

  const payments: PayableBalancePayment[] = [];
  for (const line of linesResult.data ?? []) {
    const person = peopleByWorker.get(identity(line.run_id, line.worker_type, line.worker_id));
    // Location-restricted readers must never receive a paid line whose payroll
    // person is outside their scope. An all-location orphan is retained below
    // as paid history rather than silently disappearing.
    if (!person && !canSeeAllLocations(authorization)) continue;
    payments.push({
      source: "people_payroll",
      month,
      identity: person?.identity ?? identity(line.run_id, line.worker_type, line.worker_id, "unassigned"),
      paidAmount: Number(line.amount ?? 0)
    });
  }
  return { targets, payments, error: null };
}

async function loadWorkforceMonth(
  companyId: string,
  authorization: AuthorizationContext,
  month: string
): Promise<MonthRows> {
  if (!supabaseAdmin) return { targets: [], payments: [], error: "Database connection is not configured." };
  const range = payableBalanceMonthRange(month);
  if (!range) return { targets: [], payments: [], error: "Choose a valid Workforce payout month." };

  let paidQuery = supabaseAdmin
    .from("workforce_payout_effective_paid_allocations")
    .select("payment_allocation_id,credited_workforce_id,station_id,period_start,settled_amount_snapshot")
    .eq("company_id", companyId)
    .eq("period_start", range.start)
    .eq("period_end", range.end)
    .order("payment_allocation_id");
  if (!canSeeAllLocations(authorization)) {
    paidQuery = paidQuery.in("station_id", scopedLocationIds(authorization));
  }

  const [worksheet, paidResult] = await Promise.all([
    loadStablePayoutWorksheet({
      loadRows: () => loadWorkforcePayoutRows(companyId, authorization, range.start, range.end),
      loadDependency: () => workforcePayoutDependencyHash(companyId, range.start, range.end)
    }),
    readAllRows(paidQuery)
  ]);
  const error = worksheet.error || paidResult.error?.message;
  if (error) return { targets: [], payments: [], error };

  const targetByIdentity = new Map<string, number>();
  for (const row of worksheet.rows) {
    if (!row.reviewSubjectId || !row.locationId) continue;
    const key = identity(row.reviewSubjectId, row.locationId);
    targetByIdentity.set(key, Math.max(targetByIdentity.get(key) ?? 0, Number(row.netAmount ?? 0)));
  }
  const targets: PayableBalanceTarget[] = [...targetByIdentity.entries()]
    .map(([grainIdentity, amount]) => ({
      source: "workforce",
      month,
      identity: grainIdentity,
      targetAmount: roundPayableMoney(amount)
    }));
  const payments: PayableBalancePayment[] = (paidResult.data ?? []).map((row) => ({
    source: "workforce",
    month,
    identity: identity(row.credited_workforce_id, row.station_id),
    paidAmount: Number(row.settled_amount_snapshot ?? 0)
  }));
  return { targets, payments, error: null };
}

async function loadHelpersMonth(
  companyId: string,
  authorization: AuthorizationContext,
  month: string
): Promise<MonthRows> {
  if (!supabaseAdmin) return { targets: [], payments: [], error: "Database connection is not configured." };
  const range = payableBalanceMonthRange(month);
  if (!range) return { targets: [], payments: [], error: "Choose a valid Helper payout month." };

  let itemsQuery = supabaseAdmin
    .from("helper_payout_payment_items")
    .select("id,helper_id,location_id_snapshot,period_start,payment_version,current_target_amount,status,settled_amount")
    .eq("company_id", companyId)
    .eq("period_start", range.start)
    .eq("period_end", range.end)
    .order("payment_version")
    .order("id");
  if (!canSeeAllLocations(authorization)) {
    itemsQuery = itemsQuery.in("location_id_snapshot", scopedLocationIds(authorization));
  }
  const [worksheet, itemsResult] = await Promise.all([
    loadHelperPayoutRows(companyId, authorization, range.start, range.end),
    readAllRows(itemsQuery)
  ]);
  const error = worksheet.error || itemsResult.error?.message;
  if (error) return { targets: [], payments: [], error };

  const targetByIdentity = new Map<string, number>();
  for (const row of worksheet.rows) {
    if (!row.reviewSubjectId || !row.locationId) continue;
    const key = identity(row.reviewSubjectId, row.locationId);
    targetByIdentity.set(key, Math.max(targetByIdentity.get(key) ?? 0, Number(row.netAmount ?? 0)));
  }

  const latestLedgerTarget = new Map<string, { version: number; amount: number }>();
  const payments: PayableBalancePayment[] = [];
  for (const item of itemsResult.data ?? []) {
    const key = identity(item.helper_id, item.location_id_snapshot);
    const version = Number(item.payment_version ?? 0);
    const existing = latestLedgerTarget.get(key);
    if (!existing || version >= existing.version) {
      latestLedgerTarget.set(key, { version, amount: Number(item.current_target_amount ?? 0) });
    }
    if (item.status === "paid") {
      if (item.settled_amount == null) {
        return { targets: [], payments: [], error: "A paid Helper row is missing its settled amount." };
      }
      payments.push({ source: "helpers", month, identity: key, paidAmount: Number(item.settled_amount) });
    }
  }
  // Publications are optional for Helpers. A terminal ledger snapshot is the
  // only durable historical target after an inactive profile leaves the live
  // worksheet, so use the latest snapshot only when no live target exists.
  for (const [key, ledger] of latestLedgerTarget) {
    if (!targetByIdentity.has(key)) targetByIdentity.set(key, ledger.amount);
  }
  const targets: PayableBalanceTarget[] = [...targetByIdentity.entries()]
    .map(([grainIdentity, amount]) => ({
      source: "helpers",
      month,
      identity: grainIdentity,
      targetAmount: roundPayableMoney(amount)
    }));
  return { targets, payments, error: null };
}

async function loadPayableBalanceMonth(
  companyId: string,
  authorization: AuthorizationContext,
  month: string
): Promise<MonthRows> {
  const [people, workforce, helpers] = await Promise.all([
    loadPeoplePayrollMonth(companyId, authorization, month),
    loadWorkforceMonth(companyId, authorization, month),
    loadHelpersMonth(companyId, authorization, month)
  ]);
  const errors = [
    people.error ? sourceError("People Payroll", people.error) : null,
    workforce.error ? sourceError("Workforce payouts", workforce.error) : null,
    helpers.error ? sourceError("Helpers", helpers.error) : null
  ].filter(Boolean);
  return {
    targets: [...people.targets, ...workforce.targets, ...helpers.targets],
    payments: [...people.payments, ...workforce.payments, ...helpers.payments],
    error: errors.length ? errors.join(" ") : null
  };
}

export async function loadPayableBalance(
  companyId: string,
  authorization: AuthorizationContext,
  selection: string
): Promise<PayableBalanceLoadResult> {
  const available = await loadAvailableMonths(companyId, authorization);
  if (available.error) return { months: [], grains: [], error: available.error };
  const selectedMonth = payableBalanceMonthRange(selection) ? selection : todayKolkata().slice(0, 7);
  const months = selection === "all-pending"
    ? available.months
    : [selectedMonth];
  if (!available.months.includes(selectedMonth)) available.months.push(selectedMonth);
  available.months.sort((left, right) => right.localeCompare(left));

  const monthResults = await mapWithConcurrency(months, 2, (month) =>
    loadPayableBalanceMonth(companyId, authorization, month)
  );
  const error = monthResults.find((result) => result.error)?.error ?? null;
  if (error) return { months: available.months, grains: [], error };
  return {
    months: available.months,
    grains: reconcilePayableBalance(
      monthResults.flatMap((result) => result.targets),
      monthResults.flatMap((result) => result.payments)
    ),
    error: null
  };
}

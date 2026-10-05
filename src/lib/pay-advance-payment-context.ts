import "server-only";

import { indiaMonthStart, monthEnd, workingDaysFromStatuses } from "@/lib/pay-advance-worker-facts";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type PayAdvanceWorkerContext = {
  name: string;
  workerCode: string;
  applyingMonth: string;
  workingDays: number;
  monthlyCtc: number | null;
  monthlyGross: number | null;
};

type AdvanceRequestRow = {
  id: string;
  worker_type: "employee" | "contractor";
  worker_id: string;
  worker_name: string | null;
  worker_code: string | null;
  requested_at: string | null;
};

type PaymentAdvanceRef = {
  id: string;
  sourceId: string | null;
  sourceType: string | null;
  requestedForName: string | null;
  workerCode: string | null;
  createdAt: string;
  workDate: string | null;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberOrNull(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : null;
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function loadPayAdvanceWorkerContexts(companyId: string, requests: PaymentAdvanceRef[]) {
  const contexts = new Map<string, PayAdvanceWorkerContext>();
  const advanceIds = requests
    .filter((request) => request.sourceType === "pay_advance" && request.sourceId)
    .map((request) => request.sourceId as string);
  if (!advanceIds.length) return contexts;

  const advances = await db()
    .from("hr_pay_advance_requests")
    .select("id, worker_type, worker_id, worker_name, worker_code, requested_at")
    .eq("company_id", companyId)
    .in("id", advanceIds);
  if (advances.error) return contexts;
  const advanceById = new Map(((advances.data ?? []) as AdvanceRequestRow[]).map((row) => [row.id, row]));

  const workers = new Map<string, { workerType: "employee" | "contractor"; workerId: string; monthStart: string }>();
  for (const request of requests) {
    const advance = request.sourceId ? advanceById.get(request.sourceId) : undefined;
    if (!advance || (advance.worker_type !== "employee" && advance.worker_type !== "contractor")) continue;
    const monthStart = indiaMonthStart(advance.requested_at ?? request.workDate ?? request.createdAt);
    workers.set(`${advance.worker_type}:${advance.worker_id}:${monthStart}`, {
      workerType: advance.worker_type,
      workerId: advance.worker_id,
      monthStart
    });
  }

  const attendanceByWorkerMonth = new Map<string, string[]>();
  const payByWorkerMonth = new Map<string, { ctc: number | null; gross: number | null }>();
  await Promise.all([...workers.values()].map(async (worker) => {
    const end = monthEnd(worker.monthStart);
    const key = `${worker.workerType}:${worker.workerId}:${worker.monthStart}`;
    const attendanceColumn = worker.workerType === "employee" ? "employee_id" : "contractor_id";
    const [attendance, payroll, profile] = await Promise.all([
      db().from("attendance_daily").select("status").eq("company_id", companyId).eq(attendanceColumn, worker.workerId).gte("punch_date", worker.monthStart).lte("punch_date", end),
      db().from("hr_payroll_run_people").select("monthly_gross_salary, monthly_ctc, hr_payroll_runs!inner(period_start, updated_at)").eq("company_id", companyId).eq("worker_type", worker.workerType).eq("worker_id", worker.workerId).eq("hr_payroll_runs.period_start", worker.monthStart).order("updated_at", { foreignTable: "hr_payroll_runs", ascending: false }).limit(1),
      worker.workerType === "contractor"
        ? db().from("hr_contractor_pay_profiles").select("payment_basis, base_amount, effective_from, effective_to").eq("company_id", companyId).eq("contractor_id", worker.workerId).lte("effective_from", end).or(`effective_to.is.null,effective_to.gte.${worker.monthStart}`).order("effective_from", { ascending: false }).limit(1)
        : db().from("hr_employee_salary_assignments").select("effective_from, effective_to, hr_employee_salary_values(amount, hr_payroll_heads(code, head_type))").eq("company_id", companyId).eq("employee_id", worker.workerId).lte("effective_from", end).or(`effective_to.is.null,effective_to.gte.${worker.monthStart}`).order("effective_from", { ascending: false }).limit(1)
    ]);
    attendanceByWorkerMonth.set(key, attendance.error ? [] : (attendance.data ?? []).map((row) => String(row.status ?? "")));
    const profileRows = profile.error ? [] : profile.data ?? [];

    const payrollRow = payroll.error ? undefined : (payroll.data ?? [])[0] as { monthly_gross_salary?: number | string | null; monthly_ctc?: number | string | null } | undefined;
    let gross = numberOrNull(payrollRow?.monthly_gross_salary);
    let ctc = numberOrNull(payrollRow?.monthly_ctc);
    if (worker.workerType === "contractor") {
      const pay = (profileRows[0] ?? null) as { payment_basis?: string | null; base_amount?: number | string | null } | null;
      const base = numberOrNull(pay?.base_amount);
      const monthly = pay?.payment_basis === "daily" && base != null
        ? roundMoney(base * Number(monthEnd(worker.monthStart).slice(8)))
        : base;
      gross = gross ?? monthly;
      ctc = ctc ?? monthly;
    } else {
      const assignment = (profileRows[0] ?? null) as { hr_employee_salary_values?: Array<{ amount?: number | string | null; hr_payroll_heads?: { code?: string | null; head_type?: string | null } | Array<{ code?: string | null; head_type?: string | null }> | null }> } | null;
      let storedGross = 0;
      let storedCtc: number | null = null;
      let earnings = 0;
      for (const value of assignment?.hr_employee_salary_values ?? []) {
        const head = firstRelation(value.hr_payroll_heads);
        const amount = Number(value.amount ?? 0);
        if (!Number.isFinite(amount)) continue;
        const code = String(head?.code ?? "").toUpperCase();
        const type = String(head?.head_type ?? "");
        if (type === "ctc" || code === "CTC") storedCtc = amount;
        else if (type === "gross_pay" || code === "GRPY") storedGross = amount;
        else if (type === "employee_earning") earnings += amount;
      }
      gross = gross ?? numberOrNull(storedGross || earnings);
      ctc = ctc ?? numberOrNull(storedCtc);
    }
    payByWorkerMonth.set(key, { ctc, gross });
  }));

  for (const request of requests) {
    const advance = request.sourceId ? advanceById.get(request.sourceId) : undefined;
    if (!advance) continue;
    const monthStart = indiaMonthStart(advance.requested_at ?? request.workDate ?? request.createdAt);
    const key = `${advance.worker_type}:${advance.worker_id}:${monthStart}`;
    const pay = payByWorkerMonth.get(key);
    contexts.set(request.id, {
      name: advance.worker_name || request.requestedForName || "—",
      workerCode: advance.worker_code || request.workerCode || "—",
      applyingMonth: monthStart,
      workingDays: workingDaysFromStatuses(attendanceByWorkerMonth.get(key) ?? []),
      monthlyCtc: pay?.ctc ?? null,
      monthlyGross: pay?.gross ?? null
    });
  }
  return contexts;
}

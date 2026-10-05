import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import {
  deductionMonth,
  eligibleRecoveryEmployment,
  type RecoveryPerson,
  type RecoveryPolicy,
} from "./nl-loss-policy";

export async function loadRecoveryPayables(
  auth: AuthorizationContext,
  company: string,
  station: string,
  caseMonth: string,
  caseKey: string,
  policy: RecoveryPolicy,
  policyUpdated: string,
) {
  const db = supabaseAdmin!;
  const current = deductionMonth("current_month")!;
  const startDate = new Date(`${current}-01T00:00:00Z`);
  startDate.setUTCMonth(startDate.getUTCMonth() - policy.salary_month_offset);
  const month = startDate.toISOString().slice(0, 7);
  const start = `${month}-01`;
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  const directory = await db.rpc("station_audit_employee_directory", {
    p_company: company,
    p_station: station,
  });
  if (directory.error) throw Error("Station employees could not be loaded.");
  const people = (directory.data || []) as RecoveryPerson[];
  const employeeIds = people
    .filter((p) => p.ref.startsWith("employee:"))
    .map((p) => p.ref.slice(9));
  const workforceIds = people
    .filter((p) => p.ref.startsWith("workforce:"))
    .map((p) => p.ref.slice(10));
  const [employees, workforce, payroll, existing] = await Promise.all([
    employeeIds.length
      ? db
          .from("employees")
          .select("id,date_of_join,last_working_date,created_at,is_active")
          .eq("company_id", company)
          .in("id", employeeIds)
      : { data: [], error: null },
    workforceIds.length
      ? db
          .from("workforce")
          .select(
            "id,date_of_join,last_working_date,created_at,is_active,source_profile_id,source_profile_type",
          )
          .eq("company_id", company)
          .in("id", workforceIds)
      : { data: [], error: null },
    employeeIds.length
      ? readAllRows(
          db
            .from("hr_payroll_run_people")
            .select(
              "worker_id,net_pay,adjusted_net_pay,is_adjusted,calculation_status,hr_payroll_runs!inner(status,period_start,period_end,updated_at)",
            )
            .eq("company_id", company)
            .eq("worker_type", "employee")
            .in("worker_id", employeeIds)
            .eq("hr_payroll_runs.period_start", start)
            .eq("hr_payroll_runs.period_end", end)
            .order("id"),
        )
      : { data: [], error: null },
    readAllRows(
      db
        .from("nl_loss_recoveries")
        .select("month,case_key,allocations")
        .eq("company_id", company)
        .eq("is_deleted", false)
        .order("month")
        .order("case_key"),
    ),
  ]);
  if (employees.error || workforce.error || payroll.error || existing.error)
    throw Error(
      "Employee eligibility or payable salary could not be verified.",
    );
  // Calculate the same company-wide DA pay used by Dashboard, but return only the scoped station directory.
  const payouts =
    workforceIds.length && policy.salary_cap_enabled
      ? await loadWorkforcePayoutRows(
          company,
          { ...auth, hasAllLocationAccess: true },
          start,
          end,
        )
      : { rows: [], error: null };
  // A payout-source issue blocks employee deductions, but never blocks a re-dispute.
  const records = new Map<string, any>([
    ...(employees.data || []).map(
      (e) => [`employee:${e.id}`, e] as [string, any],
    ),
    ...(workforce.data || []).map(
      (w) => [`workforce:${w.id}`, w] as [string, any],
    ),
  ]);
  const checks: any[] = [];
  const result: RecoveryPerson[] = [];
  for (const person of people) {
    const record = records.get(person.ref);
    if (!record) continue;
    const duplicate =
      person.ref.startsWith("workforce:") &&
      record.source_profile_type === "employee" &&
      employeeIds.includes(record.source_profile_id);
    const employeePay = (payroll.data || [])
      .filter((p: any) => p.worker_id === person.ref.slice(9))
      .sort((a: any, b: any) =>
        String(b.hr_payroll_runs?.updated_at).localeCompare(
          String(a.hr_payroll_runs?.updated_at),
        ),
      )[0] as any;
    const eligible = !duplicate && eligibleRecoveryEmployment(record,start,end,policy,!!employeePay) && (!policy.eligible_designations.length || policy.eligible_designations.some(d => d.toLowerCase() === person.designation.toLowerCase()));
    let payable: number | null = null;
    let source =
      payouts.error && person.ref.startsWith("workforce:")
        ? "Review Dashboard payout configuration"
        : "Previous-month salary payable unavailable";
    if (person.ref.startsWith("employee:")) {
      const run = Array.isArray(employeePay?.hr_payroll_runs)
        ? employeePay.hr_payroll_runs[0]
        : employeePay?.hr_payroll_runs;
      if (
        employeePay &&
        policy.people_run_statuses.includes(run?.status) &&
        policy.people_calculation_statuses.includes(
          employeePay.calculation_status,
        )
      ) {
        payable = Math.max(
          0,
          Number(
            employeePay.is_adjusted && employeePay.adjusted_net_pay != null
              ? employeePay.adjusted_net_pay
              : employeePay.net_pay,
          ),
        );
        source = `People payroll · ${employeePay.calculation_status}`;
      }
    } else {
      const rows = payouts.rows.filter(
        (p) => p.dropxId === person.employee_code,
      );
      if (
        rows.length &&
        rows.every(
          (p) =>
            p.paymentDetailsAvailable &&
            policy.workforce_payout_statuses.includes(p.status),
        )
      ) {
        payable = Math.max(
          0,
          Math.round(rows.reduce((sum, p) => sum + p.netAmount, 0) * 100) / 100,
        );
        source = "Dashboard workforce payout worksheet";
      }
    }
    if (payable != null && !Number.isFinite(payable)) payable = null;
    const reserved = policy.reserve_other_recoveries
      ? (existing.data || [])
          .filter((r) => !(r.month === caseMonth && r.case_key === caseKey))
          .flatMap((r) => r.allocations || [])
          .filter((a: any) => a.ref === person.ref && a.salary_month === month)
          .reduce((sum: number, a: any) => sum + Number(a.amount), 0)
      : 0;
    const limit =
      payable == null
        ? null
        : Math.max(
            0,
            Math.round(
              ((payable * policy.salary_cap_percent) / 100 - reserved) * 100,
            ) / 100,
          );
    checks.push({
      company_id: company,
      employee_ref: person.ref,
      salary_month: month,
      eligible,
      payable,
      source,
      checked_at: new Date().toISOString(),
      policy_updated_at: policyUpdated,
    });
    if (eligible)
      result.push({
        ...person,
        salary_month: month,
        salary_payable: payable,
        recovery_limit: limit,
        salary_source: source,
      });
  }
  if (checks.length) {
    const saved = await db
      .from("nl_recovery_payables")
      .upsert(checks, { onConflict: "company_id,employee_ref,salary_month" });
    if (saved.error)
      throw Error("Salary limits could not be verified. Reload before saving.");
  }
  return result;
}

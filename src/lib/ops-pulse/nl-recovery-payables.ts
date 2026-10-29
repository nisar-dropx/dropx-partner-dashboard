import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import {
  eligibleRecoveryEmployment,
  type RecoveryPerson,
  type RecoveryPolicy,
} from "./nl-loss-policy";
import {
  filterLossRecoveryDebitPeople,
  isLossRecoveryManagerialTarget,
} from "./loss-recovery-controls";

export async function loadRecoveryPayables(
  auth: AuthorizationContext,
  company: string,
  station: string,
  caseMonth: string,
  caseKey: string,
  policy: RecoveryPolicy,
  policyUpdated: string,
  selectedRefs?: string[],
  payrollMonth?: string,
) {
  const db = supabaseAdmin!;
  let current = payrollMonth;
  if (!current) {
    const c = await db.from("nl_loss_month_cases").select("report,final_seen_at").eq("company_id",company).eq("month",caseMonth).eq("case_key",caseKey).single();
    if(c.error) throw Error("Recovery case could not be loaded.");
    const m=await db.rpc("nl_recovery_deduction_month",{p_report:c.data.report,p_case_month:caseMonth,p_assigned_at:new Date().toISOString(),p_final_seen_at:c.data.final_seen_at,p_timing:"current_month",p_cutoff_day:policy.payroll_cutoff_day||5});
    if(m.error || !m.data) throw Error("Recovery payroll month could not be determined.");
    current=String(m.data);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(current)) throw Error("Choose a valid payroll month.");
  const startDate = new Date(`${current}-01T00:00:00Z`);
  const month = startDate.toISOString().slice(0, 7);
  const start = `${month}-01`;
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  const directory = await db.rpc("loss_recovery_people", {
    p_company: company,
    p_station: station,
  });
  if (directory.error) throw Error("Station employees could not be loaded.");
  // Include station staff and mapped Cluster Managers / AOMs; never expose People salaries.
  const people = filterLossRecoveryDebitPeople(
    ((directory.data || []) as RecoveryPerson[]).filter(
      (p) => !selectedRefs || selectedRefs.includes(p.ref),
    ),
  );
  if (selectedRefs?.length) {
    const blocked = selectedRefs.filter(
      (ref) =>
        !people.some((p) => p.ref === ref) &&
        ((directory.data || []) as RecoveryPerson[]).some(
          (p) => p.ref === ref && isLossRecoveryManagerialTarget(p),
        ),
    );
    if (blocked.length)
      throw Error(
        "Recovery can only be allocated to station staff and its mapped Cluster Manager or Area Operations Manager.",
      );
  }
  const employeeIds = people
    .filter((p) => p.ref.startsWith("employee:"))
    .map((p) => p.ref.slice(9));
  const contractorIds = people.filter(p => p.ref.startsWith("contractor:")).map(p => p.ref.slice(11));
  const workforceIds = people
    .filter((p) => p.ref.startsWith("workforce:"))
    .map((p) => p.ref.slice(10));
  const [employees, contractors, workforce, payroll, existing] = await Promise.all([
    employeeIds.length
      ? db
          .from("employees")
          .select("id,date_of_join,last_working_date,created_at,is_active")
          .eq("company_id", company)
          .in("id", employeeIds)
      : { data: [], error: null },
    contractorIds.length ? db.from("contractors").select("id,date_of_join,last_working_date,created_at,is_active").eq("company_id",company).in("id",contractorIds) : {data:[],error:null},
    workforceIds.length
      ? db
          .from("workforce")
          .select(
            "id,date_of_join,last_working_date,created_at,is_active,source_profile_id,source_profile_type",
          )
          .eq("company_id", company)
          .in("id", workforceIds)
      : { data: [], error: null },
    employeeIds.length + contractorIds.length
      ? readAllRows(
          db
            .from("hr_payroll_run_people")
            .select(
              "worker_type,worker_id,gross_pay,net_pay,adjusted_net_pay,is_adjusted,calculation_status,hr_payroll_runs!inner(status,period_start,period_end,updated_at),hr_payroll_run_items(code,amount)",
            )
            .eq("company_id", company)
            .in("worker_type", ["employee","contractor"])
            .in("worker_id", [...employeeIds,...contractorIds])
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
  if (employees.error || contractors.error || workforce.error || payroll.error || existing.error)
    throw Error(
      "Employee eligibility or payable salary could not be verified.",
    );
  // Calculate all-location pay only for this station’s directory, preserving cross-station salary totals.
  // Capacity is pay before Ops loss recoveries: every plan for this month is subtracted as "reserved" below.
  const payouts =
    workforceIds.length
      ? await loadWorkforcePayoutRows(
          company,
          { ...auth, hasAllLocationAccess: true },
          start,
          end,
          { workforceIds, includeLossRecoveries: false },
        )
      : { rows: [], error: null };
  // A payout-source issue blocks employee deductions, but never blocks a re-dispute.
  const records = new Map<string, any>([
    ...(employees.data || []).map(
      (e) => [`employee:${e.id}`, e] as [string, any],
    ),
    ...(contractors.data || []).map(e => [`contractor:${e.id}`,e] as [string,any]),
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
      ((record.source_profile_type === "employee" && employeeIds.includes(record.source_profile_id)) || (record.source_profile_type === "contractor" && contractorIds.includes(record.source_profile_id)));
    const employeePay = (payroll.data || [])
      .filter((p: any) => `${p.worker_type}:${p.worker_id}` === person.ref)
      .sort((a: any, b: any) =>
        String(b.hr_payroll_runs?.updated_at).localeCompare(
          String(a.hr_payroll_runs?.updated_at),
        ),
      )[0] as any;
    const eligible = !duplicate && eligibleRecoveryEmployment(record,start,end,policy,!!employeePay) && (!policy.eligible_designations.length || policy.eligible_designations.some(d => d.toLowerCase() === person.designation.toLowerCase()));
    let payable: number | null = null;
    let gross: number | null = null;
    // Employees/contractors use People (HRMS) payroll only; workforce uses payout worksheets only.
    let source = person.ref.startsWith("workforce:")
      ? payouts.error
        ? "Review Dashboard payout configuration"
        : "Workforce payout unavailable · complete mapping or publish the payout first"
      : "People payroll unavailable · complete the HRMS run or payout mapping first";
    if (person.ref.startsWith("employee:") || person.ref.startsWith("contractor:")) {
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
        const adjusted =
          employeePay.is_adjusted && employeePay.adjusted_net_pay != null;
        // Add back Ops loss recoveries payroll already deducted; they are counted again as reserved below.
        const opsLoss = adjusted
          ? 0
          : (employeePay.hr_payroll_run_items || [])
              .filter((item: any) => item.code === "OPS_LOSS_RECOVERY")
              .reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
        payable = Math.max(
          0,
          Math.round(
            (Number(adjusted ? employeePay.adjusted_net_pay : employeePay.net_pay) + opsLoss) * 100,
          ) / 100,
        );
        gross = Number.isFinite(Number(employeePay.gross_pay)) ? Math.round(Number(employeePay.gross_pay) * 100) / 100 : null;
        source = `People payroll · ${employeePay.calculation_status}`;
      } else if (employeePay) {
        source = `People payroll · ${employeePay.calculation_status || run?.status || "not ready"}`;
      }
    } else if (person.ref.startsWith("workforce:")) {
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
        gross = Math.round(rows.reduce((sum, p) => sum + p.grossPayment, 0) * 100) / 100;
        source = "Dashboard workforce payout worksheet";
      }
    }
    if (payable != null && !Number.isFinite(payable)) payable = null;
    if (gross != null && !Number.isFinite(gross)) gross = null;
    const reserved = policy.reserve_other_recoveries
      ? (existing.data || [])
          .filter((r) => !(r.month === caseMonth && r.case_key === caseKey))
          .flatMap((r) => r.allocations || [])
          .filter((a: any) => a.ref === person.ref && a.salary_month === month)
          // A recurring debit reserves one instalment a month, a full debit its whole share.
          .reduce((sum: number, a: any) => sum + Number(a.monthly_amount ?? a.amount), 0)
      : 0;
    const availablePay = () =>
      payable == null
        ? null
        : Math.max(0, Math.round((payable - reserved) * 100) / 100);
    const limit = availablePay();
    checks.push({
      company_id: company,
      employee_ref: person.ref,
      salary_month: month,
      eligible,
      payable,
      gross,
      source,
      checked_at: new Date().toISOString(),
      policy_updated_at: policyUpdated,
    });
    if (eligible)
      result.push({
        ...person,
        salary_month: month,
        salary_payable: payable,
        salary_gross: gross,
        recovery_limit: limit,
        override_limit: limit,
        reserved,
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

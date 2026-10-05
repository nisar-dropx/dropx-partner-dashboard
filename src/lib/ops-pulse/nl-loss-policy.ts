export type DeductionTiming = "none" | "current_month" | "next_month";
export type RecoveryOutcome = {
  deduction_timing: DeductionTiming;
  dispute_fields_enabled: boolean;
  reason_required: boolean;
  details_required: boolean;
  attachments_enabled: boolean;
  cctv_enabled: boolean;
  code: string;
  label: string;
  allocation_required: boolean;
  remarks_required: boolean;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
};
export type RecoveryPerson = {
  ref: string;
  employee_code: string;
  full_name: string;
  designation: string;
  is_active: boolean;
  salary_month?: string;
  salary_payable?: number | null;
  recovery_limit?: number | null;
  salary_source?: string;
};
export type RecoveryPolicy = {
  active_only: boolean;
  previous_month_active_only: boolean;
  salary_cap_enabled: boolean;
  salary_month_offset: number;
  salary_cap_percent: number;
  reserve_other_recoveries: boolean;
  people_run_statuses: string[];
  people_calculation_statuses: string[];
  workforce_payout_statuses: string[];
  eligible_designations: string[];
  attachment_types: string[];
  attachment_max_count: number;
  attachment_max_mb: number;
  cctv_public_confirmation: boolean;
};
export type RecoveryAttachment = { id: string; file_name: string };
export type RecoveryDetails = {
  reason?: string;
  details?: string;
  cctv_url?: string;
  cctv_public_confirmed?: boolean;
  attachments?: RecoveryAttachment[];
};
export type LossSettings = {
  recovery_policy: RecoveryPolicy;
  recoverable_statuses: string[];
  allow_equal_split: boolean;
  allow_custom_split: boolean;
  include_inactive_people: boolean;
  history_months: number;
  updated_at: string;
};
export type Recovery = {
  recovery_details: RecoveryDetails;
  deduction_timing: DeductionTiming;
  deduction_month: string | null;
  is_deleted: boolean;
  outcome_code: string;
  outcome_label: string;
  split_mode: "equal" | "custom" | "none";
  allocations: (RecoveryPerson & { amount: number })[];
  remarks: string;
  version: number;
  source_amount: number;
  source_status: string;
  updated_by_name: string;
  updated_at: string;
};
export type NlCase = {
  case_key: string;
  month: string;
  station_code: string;
  amount: number;
  source_status: string;
  source_file: string;
  source_updated_at: string;
  details: {
    tid?: string;
    tid_approximate?: boolean;
    category?: string;
    sub_category?: string;
    impact_date?: string;
    da_name?: string;
    remarks?: string;
    extra?: Record<string, string>;
  };
  recovery: Recovery | null;
};
export function isRecoverable(status: unknown, accepted: string[]) {
  return accepted.some(
    (s) =>
      s.trim().toLowerCase() ===
      String(status ?? "")
        .trim()
        .toLowerCase(),
  );
}
export function splitRecovery(amount: number, refs: string[]) {
  const total = Math.round(amount * 100);
  const ids = [...new Set(refs)];
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !ids.length ||
    ids.length > 50
  )
    return [];
  return ids.map((employee_ref, i) => ({
    employee_ref,
    amount:
      (Math.floor(total / ids.length) + (i < total % ids.length ? 1 : 0)) / 100,
  }));
}
export function recoveryNeedsReview(row: NlCase) {
  return (
    !!row.recovery &&
    !row.recovery.is_deleted &&
    (Number(row.recovery.source_amount) !== Number(row.amount) ||
      row.recovery.source_status !== row.source_status)
  );
}
export function recoveryCsv(value: unknown) {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Only unwrap literal numeric Excel text. Never interpret arbitrary formulas.
export function canonicalNlCaseKey(key: string) {
  const match = /^(?:="(\d+)"|=(\d+))(#\d+)?$/.exec(key.trim());
  return match ? (match[1] || match[2]) + (match[3] || "") : key;
}
export function deductionMonth(timing: DeductionTiming, now = new Date()) {
  if (timing === "none") return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return new Date(
    Date.UTC(year, month - 1 + (timing === "next_month" ? 1 : 0), 1),
  )
    .toISOString()
    .slice(0, 7);
}
export function allocationError(
  amount: number,
  splits: { employee_ref: string; amount: number }[],
  people: RecoveryPerson[],
  capEnabled = false,
) {
  if (!splits.length)
    return "Select the employees responsible for the full amount.";
  if (
    splits.some(
      (s) =>
        !people.find((p) => p.ref === s.employee_ref)?.employee_code?.trim(),
    )
  )
    return "Every selected employee must have a valid station employee ID.";
  if (
    splits.some(
      (s) =>
        !Number.isFinite(s.amount) ||
        s.amount <= 0 ||
        Math.abs(s.amount * 100 - Math.round(s.amount * 100)) > 0.000001,
    )
  )
    return "Enter a positive amount with at most two decimal places for every employee.";
  if (
    splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0) !==
    Math.round(amount * 100)
  )
    return "Allocate the full loss amount. Partial recovery is not allowed.";
  if (capEnabled) {
    for (const split of splits) {
      const person = people.find((p) => p.ref === split.employee_ref)!;
      if (person.recovery_limit == null)
        return `Salary payable is unavailable for ${person.employee_code}. Complete payroll or payout mapping first.`;
      if (
        Math.round(split.amount * 100) > Math.round(person.recovery_limit * 100)
      )
        return `Recovery exceeds salary payable for ${person.employee_code}. Limit: ₹${person.recovery_limit.toLocaleString("en-IN")}. Reallocate the balance; partial recovery is not allowed.`;
    }
  }
  return "";
}

export function eligibleRecoveryEmployment(record: {is_active:boolean; date_of_join?:string|null; last_working_date?:string|null; created_at?:string|null}, start:string,end:string,policy:Pick<RecoveryPolicy,"active_only"|"previous_month_active_only">, payrollProvesEmployment=false) {
  const priorActive = (record.date_of_join ? record.date_of_join <= end : payrollProvesEmployment || !!record.created_at && record.created_at.slice(0,10) <= end) && (!record.last_working_date || record.last_working_date >= start);
  return (!policy.active_only || record.is_active === true) && (!policy.previous_month_active_only || priorActive);
}

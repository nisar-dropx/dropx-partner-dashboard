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
  /** Needs the "Mark already recovered" permission on top of Losses edit access. */
  restricted?: boolean;
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
  /** Monthly room when a cap override is recorded: the whole take-home less other recoveries. */
  override_limit?: number | null;
  salary_gross?: number | null;
  /** Monthly amount other plans already take from this person's salary month. */
  reserved?: number;
  salary_source?: string;
  /** Pay amounts are returned only for Workforce profiles. */
  pay_detail_access?: "workforce" | "restricted";
  /** People profiles expose only whether the server-side pay check is ready. */
  pay_check_state?: "ready" | "unavailable";
  /** Saved plan lines only. */
  monthly_amount?: number;
  installments?: { n: number; amount: number }[];
};
export type RecoveryPolicy = {
  directory_ceiling_designations?: string[];
  directory_excluded_designations?: string[];
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
  /** Settled on or before this day of the month → the previous month's salary (default 5, inclusive). */
  payroll_cutoff_day?: number;
  /** First salary month that carries Ops loss recoveries (YYYY-MM). */
  payroll_start_month?: string;
  /** Most instalments a recurring debit may have (default 24). */
  max_installments?: number;
  installment_thresholds_enabled?: boolean;
  installment_two_month_min?: number;
  installment_three_month_min?: number;
  installment_extra_month_step?: number;
};
export type RecoveryAttachment = { id: string; file_name: string };
export type RecoveryDetails = {
  received_amount?: string;
  receipt_reference?: string;
  received_date?: string;
  employee_id?: string;
  employee_name?: string;
  follow_up?: string;
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
export type RecoveryMode = "full" | "installments";
export type InstallmentBasis = "months" | "amount";
export type RecoveryPlan = {
  deduction_month?: string;
  mode: RecoveryMode;
  basis?: InstallmentBasis;
  value?: string;
  cap_override?: boolean;
  cap_override_reason?: string;
};
export type Recovery = {
  approval_status?: string;
  approval_note?: string;
  proposed_by?: string;
  recovery_mode?: RecoveryMode;
  installment_basis?: InstallmentBasis | null;
  installment_value?: number | null;
  cap_override?: boolean;
  cap_override_reason?: string | null;
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
  redispute?: { enabled: boolean; workflow_status: string; recovery_month: string | null } | null;
  source_final_nonrecoverable?: boolean;
  lifecycle_status?: string;
  lifecycle_version?: number;
  lifecycle_note?: string;
  source_present?: boolean;
  /** "slp" cases come from Amazon’s SLP recovery files; they share the NL recovery ledger. */
  report?: "nl" | "slp" | "station";
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
    period?: string;
    case_status?: string;
    closed_date?: string;
    in_initial?: boolean;
    in_final?: boolean;
    final_published?: boolean;
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
export function recoveryPending(recovery: Recovery | null) {
  return !recovery || recovery.is_deleted || ["proposed", "returned", "needs_review"].includes(recovery.approval_status || "") || ["post_dispute", "non_recoverable", "da_left", "utr_left", "responsible_left"].includes(recovery.outcome_code);
}
export function recoveryNeedsReview(row: NlCase) {
  return (
    !!row.recovery &&
    !row.recovery.is_deleted &&
    (["post_dispute", "non_recoverable", "da_left", "utr_left"].includes(row.recovery.outcome_code) || Number(row.recovery.source_amount) !== Number(row.amount) ||
      // SLP Initial → Final at the same amount is the settled loss the plan already covers.
      (row.report !== "slp" && row.recovery.source_status !== row.source_status))
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
/**
 * A person's recovery schedule in rupees, the same rule save_nl_recovery applies: equal months with the
 * remainder paise on the first instalments, or a fixed monthly amount with a smaller last instalment.
 */
export function installmentSchedule(
  amount: number,
  plan: Pick<RecoveryPlan, "mode" | "basis" | "value">,
  maxInstallments = 24,
): { schedule: number[]; error: string } {
  const total = Math.round(amount * 100);
  if (!Number.isSafeInteger(total) || total <= 0) return { schedule: [], error: "" };
  if (plan.mode !== "installments") return { schedule: [total / 100], error: "" };
  const max = Math.min(60, Math.max(2, Math.trunc(maxInstallments) || 24));
  const raw = String(plan.value ?? "").trim();
  if (plan.basis !== "months" && plan.basis !== "amount")
    return { schedule: [], error: "Choose instalments by number of months or by amount per month." };
  if (!/^\d+(\.\d{1,2})?$/.test(raw))
    return { schedule: [], error: plan.basis === "months" ? "Enter the number of months." : "Enter the monthly amount." };
  const value = Number(raw);
  if (plan.basis === "months") {
    if (!Number.isInteger(value) || value < 2 || value > max)
      return { schedule: [], error: `Instalments must be between 2 and ${max} months.` };
    if (total < value * 100)
      return { schedule: [], error: `The share is too small for ${value} instalments.` };
    const per = Math.floor(total / value), rem = total % value;
    return { schedule: Array.from({ length: value }, (_, i) => (per + (i < rem ? 1 : 0)) / 100), error: "" };
  }
  const per = Math.round(value * 100);
  if (per < 100) return { schedule: [], error: "The monthly amount must be at least ₹1." };
  if (per >= total) return { schedule: [], error: "The monthly amount covers the whole share. Use Full debit instead." };
  const count = Math.ceil(total / per);
  if (count > max)
    return { schedule: [], error: `At ₹${value.toLocaleString("en-IN")} a month this needs ${count} instalments; the maximum is ${max}.` };
  return { schedule: Array.from({ length: count }, (_, i) => Math.min(per, total - i * per) / 100), error: "" };
}

/** Amount thresholds are exclusive and apply to each person's share. */
export function installmentThresholdError(amount: number, count: number, policy?: Partial<RecoveryPolicy>) {
  if (!policy?.installment_thresholds_enabled || count <= 1) return "";
  const threshold = count === 2 ? Number(policy.installment_two_month_min) : Number(policy.installment_three_month_min) + (count - 3) * Number(policy.installment_extra_month_step);
  if (!Number.isFinite(threshold) || threshold <= 0) return "Recurring recovery rules are incomplete. Contact the Recovery Master administrator.";
  return Math.round(amount * 100) <= Math.round(threshold * 100)
    ? `${count} months requires a recovery share above ₹${threshold.toLocaleString("en-IN")}. Choose fewer months or Full debit.` : "";
}

export function allocationError(
  amount: number,
  splits: { employee_ref: string; amount: number }[],
  people: RecoveryPerson[],
  capEnabled = false,
  plan: RecoveryPlan = { mode: "full" },
  maxInstallments = 24,
  capPercent = 100,
  policy?: Partial<RecoveryPolicy>,
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
  const invalidAmounts = splits.filter(
    (s) =>
      !Number.isFinite(s.amount) ||
      s.amount <= 0 ||
      Math.abs(s.amount * 100 - Math.round(s.amount * 100)) > 0.000001,
  );
  if (invalidAmounts.length) {
    const codes = invalidAmounts
      .map((s) => people.find((p) => p.ref === s.employee_ref)?.employee_code)
      .filter(Boolean);
    return codes.length
      ? `Enter the recovery amount for ${codes.join(", ")} in the Amount (₹) field on the right (positive, at most two decimals).`
      : "Enter a positive recovery amount with at most two decimal places for every selected person.";
  }
  const allocated = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
  if (allocated !== Math.round(amount * 100))
    return `Allocated amounts total ₹${(allocated / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}; assign the full loss of ₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Partial recovery is not allowed.`;
  const override = !!plan.cap_override;
  if (override) {
    const reason = String(plan.cap_override_reason ?? "").trim();
    if (reason.length < 10 || reason.length > 500)
      return "Give a reason for recovering beyond the salary cap (10–500 characters).";
  }
  for (const split of splits) {
    const person = people.find((p) => p.ref === split.employee_ref)!;
    const { schedule, error } = installmentSchedule(split.amount, plan, maxInstallments);
    if (error) return `${person.employee_code}: ${error}`;
    const thresholdError = installmentThresholdError(split.amount, schedule.length, policy);
    if (thresholdError) return `${person.employee_code}: ${thresholdError}`;
    const monthly = Math.round((schedule[0] ?? 0) * 100);
    // People-profile payroll figures are deliberately absent from the browser.
    // The database performs the authoritative cap and gross-pay checks on save.
    const privatePeoplePay = person.pay_detail_access === "restricted";
    if (capEnabled && !privatePeoplePay) {
      const limit = override ? person.override_limit : person.recovery_limit;
      if (limit == null)
        return `Salary payable is unavailable for ${person.employee_code}. Complete payroll or payout mapping first.`;
      if (monthly > Math.round(limit * 100))
        return `The monthly recovery of ₹${(monthly / 100).toLocaleString("en-IN")} for ${person.employee_code} is more than the ${override ? "take-home" : `${capPercent}%`} salary limit of ₹${limit.toLocaleString("en-IN")}. ${override ? "Spread it over more instalments." : "Spread it over more instalments, or record a cap override."}`;
    }
    if (!privatePeoplePay && person.salary_gross != null && monthly > Math.round(person.salary_gross * 100))
      return `The monthly recovery for ${person.employee_code} is more than their gross pay of ₹${person.salary_gross.toLocaleString("en-IN")}.`;
  }
  return "";
}

export function eligibleRecoveryEmployment(record: {is_active:boolean; date_of_join?:string|null; last_working_date?:string|null; created_at?:string|null}, start:string,end:string,policy:Pick<RecoveryPolicy,"active_only"|"previous_month_active_only">, payrollProvesEmployment=false) {
  const priorActive = (record.date_of_join ? record.date_of_join <= end : payrollProvesEmployment || !!record.created_at && record.created_at.slice(0,10) <= end) && (!record.last_working_date || record.last_working_date >= start);
  return (!policy.active_only || record.is_active === true) && (!policy.previous_month_active_only || priorActive);
}

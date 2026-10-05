export type RecoveryOutcome = {
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
};
export type LossSettings = {
  recoverable_statuses: string[];
  allow_equal_split: boolean;
  allow_custom_split: boolean;
  include_inactive_people: boolean;
  history_months: number;
  updated_at: string;
};
export type Recovery = {
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

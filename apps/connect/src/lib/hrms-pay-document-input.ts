import type { PayDocumentInput, PayLineItem, SalaryVersion } from "./hrms-pay-document-pdf";

export type PayDocumentSettings = {
  displayCompanyName: string;
  registeredAddress: string;
  footerText: string;
  authorisedSignatory: string;
  showAttendance: boolean;
};

export type PayDocumentPersonRow = {
  worker_type: "employee" | "contractor";
  worker_code: string | null;
  worker_name: string;
  location_name: string | null;
  department_name: string | null;
  designation_name: string | null;
  payment_basis: string | null;
  expected_days: number | string | null;
  present_days: number | string | null;
  paid_leave_days: number | string | null;
  absence_days: number | string | null;
  half_days: number | string | null;
  payable_days?: number | string | null;
  weekoff_days?: number | string | null;
  wfh_days?: number | string | null;
  gross_pay: number | string | null;
  statutory_deductions: number | string | null;
  attendance_deductions: number | string | null;
  other_deductions: number | string | null;
  employer_contributions: number | string | null;
  net_pay: number | string | null;
  adjusted_net_pay?: number | string | null;
  calculation_snapshot?: unknown;
};

export type PayDocumentItemRow = {
  code?: string | null;
  name: string;
  item_type: string;
  amount: number | string | null;
  source?: string | null;
  display_order?: number | null;
  metadata?: unknown;
};

export type PayDocumentWorkerDetails = {
  date_of_join?: string | null;
  pan_number?: string | null;
  pf_uan?: string | null;
  pf_account_no?: string | null;
  esi_no?: string | null;
  bank_account_no?: string | null;
  ifsc?: string | null;
  tax_regime?: string | null;
  pran?: string | null;
};

export const PAY_DOCUMENT_PREVIEW_FOOTER = "Preview from the current payroll calculation. This is not a published payslip until the month is finalized.";

export function payDocumentSettingsFromSnapshot(snapshot: unknown): PayDocumentSettings | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const settings = (snapshot as { document_settings?: unknown }).document_settings;
  if (!settings || typeof settings !== "object") return null;
  const row = settings as Record<string, unknown>;
  if (typeof row.display_company_name !== "string") return null;
  return {
    displayCompanyName: row.display_company_name,
    registeredAddress: typeof row.registered_address === "string" ? row.registered_address : "",
    footerText: typeof row.footer_text === "string" ? row.footer_text : "This is a system-generated document.",
    authorisedSignatory: typeof row.authorised_signatory === "string" ? row.authorised_signatory : "People & Culture",
    showAttendance: row.show_attendance !== false
  };
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Payroll months that are approved or finalized carry final figures; earlier stages are previews. */
export function isIssuedPayrollStatus(status: string | null | undefined) {
  return status === "approved" || status === "locked";
}

export function payDocumentNumber(workerType: "employee" | "contractor", periodStart: string, workerCode: string | null, workerId: string) {
  return `${workerType === "employee" ? "PAY" : "CPS"}-${String(periodStart).slice(0, 7).replace("-", "")}-${workerCode || String(workerId).slice(0, 8)}`;
}

/** Salary versions saved on the payroll snapshot, in the shape the payslip prints. */
export function salaryVersionsFromSnapshot(snapshot: unknown): SalaryVersion[] {
  const versions = record(snapshot).salary_versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((value, index) => {
    const row = record(value);
    const effectiveFrom = typeof row.effectiveFrom === "string" ? row.effectiveFrom : "";
    const monthlyAmount = number(row.monthlyGross);
    if (!/^\d{4}-\d{2}-\d{2}/.test(effectiveFrom) || monthlyAmount <= 0) return [];
    return [{
      label: `V${index + 1}`,
      effectiveFrom,
      effectiveTo: typeof row.effectiveTo === "string" && row.effectiveTo ? row.effectiveTo : null,
      monthlyAmount
    }];
  });
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Variable pay lines as the payslip names them, in the order they print after the salary heads.
 * Lines that share a label print as one row: every incentive is a single "Incentive" amount, and a
 * scheduled advance instalment and an advance entered on the payroll sheet are one "Advance Deduction".
 */
const VARIABLE_LINES: Record<string, { label: string; order: number }> = {
  ARREARS: { label: "Arrears", order: 1 },
  OTHER_INCENTIVE: { label: "Incentive", order: 2 },
  EXCEPTION_ADD: { label: "Other Earnings", order: 3 },
  PAY_ADVANCE_RECOVERY: { label: "Advance Deduction", order: 1 },
  MANUAL_ADVANCE: { label: "Advance Deduction", order: 1 },
  LOSS_DEDUCTION: { label: "Loss Recovery Deduction", order: 2 },
  EXCEPTION_DEBIT: { label: "Other Deductions", order: 3 }
};

type PayItemAmount = Pick<PayDocumentItemRow, "code" | "item_type" | "amount">;

/** A salary hold is pay kept back for now, not a deduction, so it never prints on the payslip. */
function isSalaryHold(item: PayItemAmount) {
  return item.item_type === "deduction" && String(item.code ?? "").toUpperCase() === "SALARY_HOLD";
}

/**
 * Net pay as the payslip states it: what the person earned for the month after deductions,
 * including any salary that is on hold. `netPaid` is the amount payroll releases, hold already taken off.
 * It is capped at earnings less the other deductions, so a hold placed on pay that a recovery had
 * already used up does not show as pay.
 */
export function payslipNetPay(netPaid: number, items: PayItemAmount[], grossPay: number) {
  const held = items.filter(isSalaryHold).reduce((sum, item) => sum + number(item.amount), 0);
  if (held <= 0) return netPaid;
  const earningItems = items.filter((item) => item.item_type === "earning");
  const earned = earningItems.length ? earningItems.reduce((sum, item) => sum + number(item.amount), 0) : grossPay;
  const deducted = items.filter((item) => item.item_type === "deduction" && !isSalaryHold(item)).reduce((sum, item) => sum + number(item.amount), 0);
  return Math.min(round2(netPaid + held), Math.max(0, round2(earned - deducted)));
}

function variableLine(item: PayDocumentItemRow) {
  // Incentive schemes carry their own code and name, so they are recognised by where they came from.
  if (item.item_type === "earning" && item.source === "incentive_scheme") return VARIABLE_LINES.OTHER_INCENTIVE;
  return VARIABLE_LINES[String(item.code ?? "").toUpperCase()] ?? null;
}

/** Salary heads in their configured order, then the variable lines, one row per label. Lines with nothing to show are left out. */
function lineItems(items: PayDocumentItemRow[], itemType: string, withRate: boolean): PayLineItem[] {
  const fixed: PayLineItem[] = [];
  const variable = new Map<string, { order: number; amount: number }>();
  for (const item of items) {
    if (item.item_type !== itemType || isSalaryHold(item)) continue;
    const amount = number(item.amount);
    const line = variableLine(item);
    if (line) {
      const row = variable.get(line.label) ?? { order: line.order, amount: 0 };
      row.amount = round2(row.amount + amount);
      variable.set(line.label, row);
      continue;
    }
    const monthly = withRate ? number(record(item.metadata).monthly_amount) : 0;
    if (monthly > 0) fixed.push({ name: item.name, amount, rate: monthly });
    else if (amount !== 0) fixed.push({ name: item.name, amount });
  }
  const merged = [...variable.entries()]
    .filter(([, row]) => row.amount !== 0)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name, row]) => ({ name, amount: row.amount }));
  return [...fixed, ...merged];
}

/**
 * Deductions as they were actually taken from this month's pay.
 * Take-home never goes below zero, so a recovery larger than the pay left after statutory deductions
 * is only part-recovered. The payslip shows the part that was taken, so earnings less deductions
 * always equals net pay. Statutory lines are never reduced.
 */
export function deductionsTaken(deductions: PayLineItem[], totalEarnings: number, netPay: number): PayLineItem[] {
  // Only pay that was floored at zero is part-recovered. A net pay HR adjusted by hand is left as entered.
  if (netPay > 0) return deductions;
  let excess = round2(deductions.reduce((sum, item) => sum + item.amount, 0) - totalEarnings);
  if (excess <= 0) return deductions;
  const recoverable = new Set(["Advance Deduction", "Loss Recovery Deduction", "Other Deductions"]);
  const taken = deductions.map((item) => ({ ...item }));
  for (let index = taken.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (!recoverable.has(taken[index].name)) continue;
    const cut = Math.min(excess, taken[index].amount);
    taken[index].amount = round2(taken[index].amount - cut);
    excess = round2(excess - cut);
  }
  return taken.filter((item) => item.amount !== 0);
}

/**
 * Attendance figures as the payslip should show them.
 * Pay is driven by payable days, so loss-of-pay days are the days of the period that were not paid.
 * When HR entered the payable days by hand, the recorded punches no longer explain the pay,
 * so Present is shown as the paid days left after leave, week offs and half days.
 */
export function payslipAttendance(person: PayDocumentPersonRow) {
  const snapshot = record(person.calculation_snapshot);
  const expectedDays = number(person.expected_days);
  const halfDays = number(person.half_days);
  const paidLeaveDays = number(person.paid_leave_days);
  const weekoffDays = number(person.weekoff_days ?? snapshot.weekoff_days);
  const wfhDays = number(person.wfh_days ?? snapshot.wfh_days);
  const recordedPayable = person.payable_days ?? snapshot.payable_days;
  const hasPayable = recordedPayable !== null && recordedPayable !== undefined && recordedPayable !== "";
  const payableDays = hasPayable ? number(recordedPayable) : undefined;
  const round = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
  const manual = snapshot.manual_days_accepted === true && payableDays !== undefined;
  return {
    expectedDays,
    halfDays,
    paidLeaveDays,
    weekoffDays,
    wfhDays,
    payableDays,
    presentDays: manual ? round(payableDays - paidLeaveDays - weekoffDays - halfDays * 0.5) : number(person.present_days),
    absenceDays: payableDays === undefined ? number(person.absence_days) : round(expectedDays - payableDays)
  };
}

export function buildPayDocumentInput(input: {
  settings: PayDocumentSettings;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  documentNumber: string;
  publishedAt: string;
  person: PayDocumentPersonRow;
  items: PayDocumentItemRow[];
  worker: PayDocumentWorkerDetails | null;
  /** HR copy with a signature and seal block. */
  signed?: boolean;
  /** The payroll month is not approved yet, so the figures can still change. */
  preview?: boolean;
  /** Older published documents carry the attendance deduction only as a total. */
  addAttendanceDeductionFallback?: boolean;
  logoPng?: Uint8Array | null;
}): PayDocumentInput {
  const { settings, person, worker } = input;
  const items = [...input.items].sort((a, b) => number(a.display_order) - number(b.display_order));
  const snapshot = record(person.calculation_snapshot);
  const attendance = payslipAttendance(person);
  const earnings = lineItems(items, "earning", true);
  let deductions = lineItems(items, "deduction", false);
  const attendanceDeductions = number(person.attendance_deductions);
  if (input.addAttendanceDeductionFallback && attendanceDeductions > 0 && !items.some((item) => item.source === "payroll_rules")) {
    deductions.push({ name: "Attendance deduction", amount: attendanceDeductions });
  }
  const grossPay = number(person.gross_pay);
  const netPay = payslipNetPay(number(person.adjusted_net_pay ?? person.net_pay), items, grossPay);
  const heldPay = items.filter(isSalaryHold).reduce((sum, item) => sum + number(item.amount), 0);
  const totalEarnings = earnings.length ? earnings.reduce((sum, item) => sum + item.amount, 0) : grossPay;
  deductions = deductionsTaken(deductions, totalEarnings, netPay);
  const salaryVersions = salaryVersionsFromSnapshot(snapshot);
  // The saved footer says no signature is needed, which would contradict a signed copy.
  const footerText = input.preview ? PAY_DOCUMENT_PREVIEW_FOOTER : input.signed ? undefined : settings.footerText || undefined;
  return {
    companyName: settings.displayCompanyName,
    registeredAddress: settings.registeredAddress,
    footerText,
    includeSignature: Boolean(input.signed),
    authorisedSignatory: settings.authorisedSignatory,
    showAttendance: settings.showAttendance,
    periodLabel: input.periodLabel,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    documentNumber: input.documentNumber,
    workerType: person.worker_type,
    workerCode: person.worker_code,
    workerName: person.worker_name,
    locationName: person.location_name,
    departmentName: person.department_name,
    designationName: person.designation_name,
    paymentBasis: person.payment_basis,
    expectedDays: attendance.expectedDays,
    presentDays: attendance.presentDays,
    paidLeaveDays: attendance.paidLeaveDays,
    absenceDays: attendance.absenceDays,
    halfDays: attendance.halfDays,
    payableDays: attendance.payableDays,
    weekoffDays: attendance.weekoffDays,
    wfhDays: attendance.wfhDays,
    grossPay,
    statutoryDeductions: number(person.statutory_deductions),
    attendanceDeductions,
    otherDeductions: Math.max(0, round2(number(person.other_deductions) - heldPay)),
    employerContributions: number(person.employer_contributions),
    netPay,
    earnings,
    deductions,
    employerItems: lineItems(items, "employer_contribution", false),
    publishedAt: input.publishedAt,
    salaryVersions: salaryVersions.length ? salaryVersions : null,
    salaryVersionsLabel: typeof snapshot.salary_versions_label === "string" ? snapshot.salary_versions_label : null,
    dateOfJoining: worker?.date_of_join ?? null,
    bankAccountNo: worker?.bank_account_no ?? null,
    ifscCode: worker?.ifsc ?? null,
    panNumber: worker?.pan_number ?? null,
    pfUan: worker?.pf_uan ?? null,
    pfAccountNo: worker?.pf_account_no ?? null,
    esiNo: worker?.esi_no ?? null,
    taxRegime: worker?.tax_regime ?? null,
    pran: worker?.pran ?? null,
    logoPng: input.logoPng ?? null
  };
}

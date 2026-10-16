/**
 * Pre-payment cross-checks on the Workforce payout worksheet. They run on rows the page already loaded
 * (no extra queries) and flag amounts that do not agree with the underlying attendance, review or
 * bank data, so a person looks at them before the bank file. Bank-file generation itself already
 * recalculates every selected amount from live inputs.
 */

export type PayoutCheckRow = {
  id: string;
  dropxId: string;
  name: string;
  location: string;
  workDays: number;
  workDaysSource?: string;
  grossPayment: number;
  deductions: number;
  netAmount: number;
  paymentDetailsAvailable: boolean;
  publicationTargetAmount?: number | null;
  mappingStatus?: string;
};

export type PayoutCheckCode = "changed_after_review" | "paid_without_work" | "no_bank_details" | "deductions_exceed_gross" | "high_day_rate" | "work_without_pay";

export const PAYOUT_CHECKS: Record<PayoutCheckCode, { label: string; severity: "critical" | "review"; help: string }> = {
  changed_after_review: { label: "Changed after associate review", severity: "critical", help: "Net pay differs from what the associate saw in DropX One. Republish before paying." },
  paid_without_work: { label: "Pay without work days", severity: "critical", help: "Net pay with zero attendance or production days." },
  no_bank_details: { label: "Bank details missing", severity: "critical", help: "Net pay but no verified payment details; the bank file cannot carry it." },
  deductions_exceed_gross: { label: "Deductions above gross", severity: "review", help: "Deductions are larger than gross pay; check recoveries and advances." },
  high_day_rate: { label: "Unusual day rate", severity: "review", help: "Gross per work day is above the expected ceiling." },
  work_without_pay: { label: "Work without pay", severity: "review", help: "Work days recorded but gross pay is zero; check mapping and rate card." },
};

export const DAY_RATE_CEILING = 2500;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function payoutCheckFlags(row: PayoutCheckRow, dayRateCeiling = DAY_RATE_CEILING): PayoutCheckCode[] {
  const flags: PayoutCheckCode[] = [];
  const net = r2(row.netAmount), gross = r2(row.grossPayment), days = Number(row.workDays) || 0;
  const daysKnown = !String(row.workDaysSource ?? "").toLowerCase().includes("unavailable");
  if (row.publicationTargetAmount != null && Math.abs(net - r2(row.publicationTargetAmount)) >= 1) flags.push("changed_after_review");
  if (net > 0 && daysKnown && days <= 0) flags.push("paid_without_work");
  if (net > 0 && !row.paymentDetailsAvailable) flags.push("no_bank_details");
  if (r2(row.deductions) > gross && gross >= 0 && r2(row.deductions) > 0) flags.push("deductions_exceed_gross");
  if (days > 0 && gross / days > dayRateCeiling) flags.push("high_day_rate");
  if (daysKnown && days >= 1 && gross <= 0 && row.mappingStatus !== "Unmapped") flags.push("work_without_pay");
  return flags;
}

export function payoutChecks(rows: PayoutCheckRow[], dayRateCeiling = DAY_RATE_CEILING) {
  const byCode = new Map<PayoutCheckCode, PayoutCheckRow[]>();
  let flaggedAmount = 0;
  const flaggedIds = new Set<string>();
  for (const row of rows) {
    const flags = payoutCheckFlags(row, dayRateCeiling);
    if (!flags.length) continue;
    flaggedIds.add(row.id);
    flaggedAmount += r2(row.netAmount);
    for (const code of flags) byCode.set(code, [...(byCode.get(code) ?? []), row]);
  }
  const groups = (Object.keys(PAYOUT_CHECKS) as PayoutCheckCode[])
    .filter((code) => byCode.has(code))
    .map((code) => ({ code, ...PAYOUT_CHECKS[code], rows: byCode.get(code)! }));
  return {
    checked: rows.length,
    flagged: flaggedIds.size,
    flaggedAmount: r2(flaggedAmount),
    critical: groups.filter((g) => g.severity === "critical").reduce((n, g) => n + g.rows.length, 0),
    groups,
  };
}

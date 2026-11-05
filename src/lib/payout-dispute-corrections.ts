import { PAYOUT_DISPUTE_AREAS, type PayoutDisputeArea } from "./payout-dispute-areas.ts";
import { decodePayoutReviewReason } from "./payout-review-display.ts";
import { publishedPayoutBreakdown } from "../../apps/connect/src/lib/published-payout-breakdown.ts";

type Row = Record<string, any>;
export type DisputeCorrectionField = {
  area: string;
  label: string;
  kind: string;
  unit: "days" | "count" | "rupees";
  currentValue: number | null;
  unitRate: number | null;
  rateIssue?: string;
};
const number = (value: unknown) => value === null || value === undefined || value === ""
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const counts: Partial<Record<PayoutDisputeArea, { codes: string[]; legacy: string }>> = {
  delivery: { codes: ["DELIVERY", "TOTAL_DELIVERY", "AMAZON_DELIVERY", "SWA_DELIVERY"], legacy: "totalDelivery" },
  customer_return: { codes: ["CRETURN", "C_RETURN", "CUSTOMER_RETURN"], legacy: "customerReturn" },
  pickup: { codes: ["PICKUP", "TOTAL_PICKUP", "CUSTOMER_PICKUP", "SWA_PICKUP", "AMAZON_PICKUP"], legacy: "pickup" },
  mfn_seller_pickup: { codes: ["SELLER_PICKUP", "MFN"], legacy: "mfn" },
};

function uniqueRate(lines: Array<{ rate: number | null }>) {
  const rates = new Set(lines.map(line => line.rate));
  return lines.length && rates.size === 1 && !rates.has(null) ? lines[0].rate : null;
}

/** Values are frozen to the publication the associate actually disputed. Missing is never zero. */
export function payoutDisputeCorrectionFields(reason: unknown, category: unknown, snapshot: Row = {}): DisputeCorrectionField[] {
  const item = snapshot.item ?? {};
  const lines: Row[] = Array.isArray(snapshot.lines) ? snapshot.lines : [];
  const breakdown = publishedPayoutBreakdown(snapshot, lines, item);
  const selected = new Set(decodePayoutReviewReason(reason).areas);
  const areas = PAYOUT_DISPUTE_AREAS.filter(area => selected.has(area.label));
  if (!areas.length) {
    // A legacy single-category ticket does not identify a particular production field.
    const labels: Record<string, string> = { counts: "Shipments / counts", training: "Training", loss: "Deduction", tds: "TDS", other: "Others" };
    if (category === "loss") return [{ area: "deduction", label: "Deduction", kind: "deduction", unit: "rupees", currentValue: number(item.deduction_amount), unitRate: 1 }];
    return [{ area: "legacy", label: labels[String(category)] || "Others", kind: "other", unit: "rupees", currentValue: null, unitRate: null }];
  }
  return areas.map(({ value: area, label }): DisputeCorrectionField => {
    if (area === "work_days") {
      const attendance = breakdown.earnings.filter(line => ["per_day", "per_hour", "per_month"].includes(line.basis));
      const codes = [...new Set(attendance.map(line => line.code))];
      const rates = codes.map(code => uniqueRate(attendance.filter(line => line.code === code)));
      const unitRate = attendance.length && attendance.every(line => line.basis === "per_day") && rates.every(rate => rate !== null)
        ? rates.reduce<number>((sum, rate) => sum + rate!, 0) : null;
      return { area, label, kind: "workdays", unit: "days", currentValue: number(item.work_days), unitRate,
        ...(unitRate === null ? { rateIssue: "No single daily rate is recorded. For monthly, hourly or changing attendance rates, correct the Attendance Pay amount instead." } : {}) };
    }
    const production = counts[area];
    if (production) {
      const matched = breakdown.earnings.filter(line => production.codes.includes(line.code));
      const legacy = lines.filter(line => number(line.calculation_snapshot?.counts?.[production.legacy]) !== null);
      const currentValue = matched.length
        ? matched.every(line => line.units !== null) ? rounded(matched.reduce((sum, line) => sum + line.units!, 0)) : null
        : legacy.length ? rounded(legacy.reduce((sum, line) => sum + Number(line.calculation_snapshot.counts[production.legacy]), 0))
          : Array.isArray(snapshot.worksheet?.production_breakdown) ? 0 : null;
      const unitRate = uniqueRate(matched);
      return { area, label, kind: "production", unit: "count", currentValue, unitRate,
        ...(unitRate === null ? { rateIssue: "A single unit rate is unavailable in this payout. Review the rate-specific payout lines before correcting this item." } : {}) };
    }
    if (area === "attendance_pay") {
      const attendance = breakdown.earnings.filter(line => ["per_day", "per_hour", "per_month"].includes(line.basis));
      return { area, label, kind: "attendance", unit: "rupees", unitRate: 1, currentValue: attendance.length
        ? rounded(attendance.reduce((sum, line) => sum + line.amount, 0))
        : Array.isArray(snapshot.worksheet?.production_breakdown) ? 0 : null };
    }
    const fields: Partial<Record<PayoutDisputeArea, readonly [string, string]>> = {
      allowances: ["adjustment_amount", "additional_payment"],
      incentive: ["incentive_amount", "additional_payment"],
      deduction: ["deduction_amount", "deduction"],
      other: ["net_amount", "other"],
    } as const;
    const selectedField = fields[area];
    if (!selectedField) throw new Error("Unsupported dispute item.");
    const [field, kind] = selectedField;
    return { area, label: area === "other" ? "Others — net payout" : label, kind, unit: "rupees", unitRate: 1, currentValue: number(item[field]) };
  });
}

/** Read-only form fields are display only; reconstruct all identities and current values server-side. */
export function buildDisputeCorrectionPlan(fields: DisputeCorrectionField[], form: FormData) {
  if (!fields.length || fields.some(field => field.currentValue === null)) {
    throw new Error("The disputed field's current value is unavailable in this publication. Review the payout evidence before proposing a correction.");
  }
  const items = fields.map(field => {
    const values = form.getAll(`corrected_${field.area}`);
    const value = values.length === 1 && typeof values[0] === "string" ? values[0].trim() : "";
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(Math.round(Number(value) * 100))) {
      throw new Error(`Enter a valid corrected value for ${field.label}.`);
    }
    const proposed = Number(value);
    const difference = Math.round(proposed * 100) - Math.round(field.currentValue! * 100);
    if (difference !== 0 && field.unitRate === null) throw new Error(`${field.label}: ${field.rateIssue || "The payout unit rate is unavailable."}`);
    const rawDelta = difference === 0 ? 0 : difference * field.unitRate! * (field.area === "deduction" ? -1 : 1);
    const delta = Math.sign(rawDelta) * Math.round(Math.abs(rawDelta));
    if (!Number.isSafeInteger(delta)) throw new Error("Expected payout difference is outside the supported range.");
    return { area: field.area, kind: field.kind, target_field: field.label, unit: field.unit,
      current_value: field.currentValue!, proposed_value: proposed, unit_rate: field.unitRate, expected_delta_paise: delta };
  });
  const changed = items.filter(item => item.proposed_value !== item.current_value);
  if ((changed.some(item => item.area === "other") && changed.length > 1)
    || (changed.some(item => item.area === "work_days") && changed.some(item => item.area === "attendance_pay"))) {
    throw new Error("These corrections overlap. Correct either the net payout or its individual items, and either Work Days or Attendance Pay, to avoid counting the same change twice.");
  }
  const expectedDeltaPaise = items.reduce((sum, item) => sum + item.expected_delta_paise, 0);
  if (!Number.isSafeInteger(expectedDeltaPaise)) throw new Error("Expected payout difference is outside the supported range.");
  // Summary fields retain compatibility with the existing v2 transition and older clients.
  return { kind: items.length === 1 ? items[0].kind : "other",
    target_field: items.map(item => item.target_field).join("; "),
    current_value: items.map(item => `${item.target_field}: ${item.current_value}`).join("; "),
    proposed_value: items.map(item => `${item.target_field}: ${item.proposed_value}`).join("; "),
    items, expected_delta_paise: expectedDeltaPaise };
}

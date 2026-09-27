export const PAYOUT_DISPUTE_AREAS = [
  { value: "work_days", label: "Work Days", legacyCategory: "training" },
  { value: "attendance_pay", label: "Attendance Pay", legacyCategory: "training" },
  { value: "delivery", label: "Delivery", legacyCategory: "counts" },
  { value: "pickup", label: "Pickup", legacyCategory: "counts" },
  { value: "mfn_seller_pickup", label: "MFN / Seller Pickup", legacyCategory: "counts" },
  { value: "allowances", label: "Allowances", legacyCategory: "other" },
  { value: "incentive", label: "Incentive", legacyCategory: "other" },
  { value: "deduction", label: "Deduction", legacyCategory: "loss" },
  { value: "other", label: "Others", legacyCategory: "other" },
] as const;

export type PayoutDisputeArea = (typeof PAYOUT_DISPUTE_AREAS)[number]["value"];
export type PayoutReviewState = "open" | "expired" | "revising" | "confirmed" | "unavailable";

const areaByValue = new Map(PAYOUT_DISPUTE_AREAS.map((area) => [area.value, area]));
const areaPrefix = "Dispute areas: ";

export function normalizePayoutDisputeAreas(value: unknown): PayoutDisputeArea[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim()).filter((item): item is PayoutDisputeArea => areaByValue.has(item as PayoutDisputeArea)))];
}

export function payoutDisputeAreaLabels(areas: readonly PayoutDisputeArea[]) {
  return areas.map((area) => areaByValue.get(area)!.label);
}

/**
 * The production RPC stores one legacy category. Keep that contract stable while
 * preserving every selected area in the dispute reason for old and new reviewers.
 */
export function legacyPayoutDisputeCategory(areas: readonly PayoutDisputeArea[]) {
  const categories = areas.map((area) => areaByValue.get(area)?.legacyCategory).filter(Boolean);
  if (categories.includes("counts")) return "counts";
  if (categories.includes("training")) return "training";
  if (categories.includes("loss")) return "loss";
  return "other";
}

export function encodePayoutDisputeReason(areas: readonly PayoutDisputeArea[], reason: string) {
  const labels = payoutDisputeAreaLabels(areas);
  return `${areaPrefix}${labels.join(", ")}\n\n${reason.trim()}`;
}

export function decodePayoutDisputeReason(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith(areaPrefix)) return { areas: [] as string[], reason: text };
  const [heading, ...body] = text.split(/\r?\n/);
  return {
    areas: heading.slice(areaPrefix.length).split(",").map((item) => item.trim()).filter(Boolean),
    reason: body.join("\n").trim(),
  };
}

export function payoutReviewState(
  input: { hasPublication: boolean; reviewUntil?: string | null; runStatus?: string | null; revisionPending?: boolean },
  now = Date.now(),
): PayoutReviewState {
  if (!input.hasPublication) return "unavailable";
  if (["approved", "paid"].includes(String(input.runStatus ?? ""))) return "confirmed";
  if (input.runStatus !== "review") return "unavailable";
  if (input.revisionPending) return "revising";
  const deadline = Date.parse(String(input.reviewUntil ?? ""));
  if (!Number.isFinite(deadline)) return "unavailable";
  return deadline > now ? "open" : "expired";
}

export function isCompleteCalendarMonth(from: string, to: string) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(from);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  return to === new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function currentPayoutMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : now.toISOString().slice(0, 7);
}

export function shiftPayoutMonth(value: string, amount: number) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return currentPayoutMonth();
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1));
  return shifted.toISOString().slice(0, 7);
}

export function payoutMonthLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en", { month: "short", year: "2-digit", timeZone: "UTC" })
    .format(new Date(`${value}-01T00:00:00Z`))
    .replace(" ", "-");
}

export function payoutMonthLongLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}-01T00:00:00Z`));
}

/** Cross-month pay periods are filed under the month in which the period ends. */
export function payoutMonthForPeriod(from: string, to: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) return to.slice(0, 7);
  return /^\d{4}-\d{2}-\d{2}$/.test(from) ? from.slice(0, 7) : "";
}

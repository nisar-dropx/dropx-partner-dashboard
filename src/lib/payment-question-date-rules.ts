export type PaymentQuestionDateRule = "any" | "today" | "past" | "future";

export type PaymentQuestionDateConfig = {
  answer_type?: string | null;
  date_rule?: string | null;
  date_days?: number | null;
  question_text?: string | null;
};

export function normalizePaymentQuestionDateRule(value?: string | null): PaymentQuestionDateRule {
  return value === "today" || value === "past" || value === "future" ? value : "any";
}

function calendarDateInIndia(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftCalendarDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function isCalendarDate(value?: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function paymentQuestionDateBounds(config: PaymentQuestionDateConfig, now = new Date()) {
  const rule = normalizePaymentQuestionDateRule(config.date_rule);
  const today = calendarDateInIndia(now);
  const days = Math.max(1, Math.trunc(Number(config.date_days) || 1));
  if (rule === "today") return { min: today, max: today, helper: "Current date only" };
  if (rule === "past") return { min: shiftCalendarDate(today, -days), max: shiftCalendarDate(today, -1), helper: `Past ${days} day${days === 1 ? "" : "s"} only` };
  if (rule === "future") return { min: shiftCalendarDate(today, 1), max: shiftCalendarDate(today, days), helper: `Next ${days} day${days === 1 ? "" : "s"} only` };
  return { min: undefined, max: undefined, helper: undefined };
}

/** On resubmit, keep a previously saved date selectable even if the sliding window has moved. */
export function paymentQuestionDateBoundsForValue(
  config: PaymentQuestionDateConfig,
  existingValue?: string | null,
  now = new Date()
) {
  const bounds = paymentQuestionDateBounds(config, now);
  if (!isCalendarDate(existingValue)) return bounds;
  const min = bounds.min && existingValue < bounds.min ? existingValue : bounds.min;
  const max = bounds.max && existingValue > bounds.max ? existingValue : bounds.max;
  if (min === bounds.min && max === bounds.max) return bounds;
  return {
    min,
    max,
    helper: bounds.helper ? `${bounds.helper}; original date kept if unchanged` : undefined,
  };
}

export function validatePaymentQuestionDate(
  value: string | null,
  config: PaymentQuestionDateConfig,
  now = new Date(),
  options?: { existingValue?: string | null }
) {
  if (config.answer_type !== "date" || !value) return;
  if (!isCalendarDate(value)) throw new Error(`${config.question_text || "Date"}: enter a valid date.`);
  // Returned requests may be corrected days later. Keep the originally accepted date valid when
  // unchanged so "today only" (and similar) rules do not block resubmission.
  const existingValue = options?.existingValue?.trim() || null;
  if (existingValue && value === existingValue) return;
  const bounds = paymentQuestionDateBounds(config, now);
  if ((bounds.min && value < bounds.min) || (bounds.max && value > bounds.max)) {
    throw new Error(`${config.question_text || "Date"}: ${bounds.helper ?? "date is outside the allowed range"}.`);
  }
}

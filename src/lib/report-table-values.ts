/** Shared display-value ordering. IDs stay text; blank values stay last in either direction. */
export type ReportSort = { column: number; direction: "asc" | "desc" };
const collator = new Intl.Collator("en-IN", { numeric: true, sensitivity: "base" });
const blank = (value: string) => !value.trim() || /^[—–-]$/.test(value.trim());
const numeric = /^[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)%?$/;

export function reportNumber(value: string): number | null {
  const cleaned = value.trim().replace(/−/g, "-").replace(/^([+-]\s*)?(?:₹|Rs\.?|INR)\s*/i, "$1").replace(/^([+-])\s+/, "$1");
  const accounting = /^\([\d,.]+\)$/.test(cleaned) ? `-${cleaned.slice(1, -1)}` : cleaned;
  return numeric.test(accounting) ? Number(accounting.replace(/[,%]/g, "")) : null;
}

function dateNumber(value: string): number | null {
  // Never let Date.parse guess whether a small integer is a month or a year.
  if (/^\d{4}-\d{2}(?:-\d{2}(?:T.*)?)?$/.test(value)) {
    const n = Date.parse(value); return Number.isFinite(n) ? n : null;
  }
  const indian = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/);
  if (indian) {
    const n = Date.parse(`${indian[3]}-${indian[2].padStart(2, "0")}-${indian[1].padStart(2, "0")}${indian[4]}`);
    return Number.isFinite(n) ? n : null;
  }
  if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.test(value)) {
    const n = Date.parse(value); return Number.isFinite(n) ? n : null;
  }
  const time = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (time) return ((Number(time[1]) % (time[4] ? 12 : 24)) + (/pm/i.test(time[4] || "") ? 12 : 0)) * 3600 + Number(time[2]) * 60 + Number(time[3] || 0);
  return null;
}

export function compareReportValues(a: string, b: string, direction: "asc" | "desc" = "asc"): number {
  if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
  const an = reportNumber(a), bn = reportNumber(b);
  const ad = dateNumber(a), bd = dateNumber(b);
  const result = an != null && bn != null ? an - bn : ad != null && bd != null ? ad - bd : collator.compare(a, b);
  return direction === "asc" ? result : -result;
}

export function excelReportValue(value: string, heading: string): string | number {
  // Prevent identifier precision loss, leading-zero loss, and formula interpretation.
  if (/(?:\bid\b|\bids\b|shipment|tracking|\btid\b|ticket|reference|phone|mobile|account|pin.?code|\bcode\b|\butr\b)/i.test(heading) || /^0\d/.test(value)) return value;
  const number = reportNumber(value);
  return number != null && Number.isSafeInteger(Math.trunc(number)) && !value.trim().endsWith("%") ? number : value;
}

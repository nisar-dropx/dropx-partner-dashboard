/** Dated Flex transporter (A…) assignments for payable distance. */

export type AmazonTransporterAssignment = {
  id: string;
  company_id: string;
  station_id: string;
  workforce_id: string;
  transporter_id: string;
  effective_from: string;
  effective_to: string | null;
  created_at?: string;
  updated_at?: string;
};

export const AMAZON_TRANSPORTER_ID_RE = /^A[A-Z0-9]{5,31}$/;

export function normalizeAmazonTransporterId(raw: string): string {
  return String(raw || "").trim().toUpperCase();
}

export function isValidAmazonTransporterId(raw: string): boolean {
  return AMAZON_TRANSPORTER_ID_RE.test(normalizeAmazonTransporterId(raw));
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Inclusive date ranges overlap when each starts on/before the other's end. */
export function dateRangesOverlap(
  fromA: string,
  toA: string | null,
  fromB: string,
  toB: string | null,
): boolean {
  const endA = toA ?? "9999-12-31";
  const endB = toB ?? "9999-12-31";
  return fromA <= endB && fromB <= endA;
}

export function dayBefore(isoDate: string): string {
  return new Date(Date.parse(isoDate + "T00:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
}

export function eachIsoDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = new Date(Date.parse(cur + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10);
  }
  return out;
}

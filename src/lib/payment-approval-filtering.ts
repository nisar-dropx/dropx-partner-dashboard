const DASHBOARD_TIME_ZONE = "Asia/Kolkata";

export type PaymentApprovalFacetRow = {
  location_code: string | null;
  payment_head_id: string | null;
  created_at: string;
};

export type PaymentApprovalFacetSelection = {
  stations: string[];
  paymentHeads: string[];
  dates: string[];
};

export function paymentApprovalDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: DASHBOARD_TIME_ZONE
  }).format(date);
}

export function selectedPaymentApprovalValues(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function matchesPaymentApprovalFacets(
  request: PaymentApprovalFacetRow,
  selection: PaymentApprovalFacetSelection
) {
  if (selection.stations.length && !selection.stations.includes(String(request.location_code ?? ""))) return false;
  if (selection.paymentHeads.length && !selection.paymentHeads.includes(String(request.payment_head_id ?? ""))) return false;
  if (selection.dates.length && !selection.dates.includes(paymentApprovalDateKey(request.created_at))) return false;
  return true;
}

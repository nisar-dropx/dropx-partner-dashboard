export type WorkforcePayoutFilterableRow = {
  dropxId: string;
  dropxStatus: string;
  name: string;
  providerMemberId: string;
  providerMemberName: string;
  designation: string;
  location: string;
  provider: string;
  mappingStatus: string;
  status: string;
  paymentMethodBreakdown: Array<{ label: string }>;
  model?: string;
  bankFileStatus?: string;
  paymentSummary?: {
    status: string | null;
    paidAmount: number;
    processingAmount: number;
    balancePayable: number;
    eligible: boolean | null;
    eligibilityCode: string | null;
  };
};

// Payment state comes from the bank ledger, independently of publication/review.
export function workforcePayoutPaymentStatus(row: WorkforcePayoutFilterableRow) {
  const s = row.paymentSummary;
  if (!s) return "Not available";
  // The merged row can include a newer payout target than the published snapshot.
  if (row.status === "Partially Paid") return "Partially paid";
  if (row.status === "Paid") return "Paid";
  if (s.status === "Paid") return "Paid";
  if (s.status === "Partially Paid") return "Partially paid";
  if (s.processingAmount > 0 || s.status === "Payment Processing") return "Processing";
  if (s.status === "Payment Failed") return "Failed";
  if (s.status === "Payment Cancelled") return "Cancelled";
  if (s.paidAmount > 0 && s.balancePayable > 0) return "Partially paid";
  if (s.eligible === null) return "Not available";
  if (s.eligibilityCode === "no_positive_balance") return "No balance due";
  return "Unpaid";
}

export function workforcePayoutHoldStatus(row: WorkforcePayoutFilterableRow) {
  if ([row.status, row.paymentSummary?.status].some(s => s === "On Hold" || s === "Payment On Hold")
      || row.paymentSummary?.eligibilityCode === "payment_on_hold") return "On hold";
  return row.paymentSummary ? "Not on hold" : "Not available";
}

export function workforcePayoutReadiness(row: WorkforcePayoutFilterableRow) {
  const s = row.paymentSummary;
  if (!s || s.eligible === null) return "Not available";
  if (s.eligible) return "Ready to pay";
  const labels: Record<string, string> = {
    publication_missing: "Not published", publication_refresh_pending: "Refresh pending",
    publication_stale_or_incomplete: "Republish required", mapping_relock_required: "Relock required",
    payment_on_hold: "On hold", payout_dispute_open: "Dispute pending", pan_not_linked: "PAN not linked",
    profile_not_active: "Inactive profile", profile_unavailable: "Profile unavailable",
    payment_processing: "Processing", no_positive_balance: "No balance due",
    beneficiary_bank_details_missing: "Bank details required", beneficiary_bank_account_invalid: "Invalid bank details",
    beneficiary_ifsc_invalid: "Invalid bank details", payment_reference_invalid: "Invalid payment reference",
    current_location_missing: "Location missing",
  };
  return labels[s.eligibilityCode?.trim().toLowerCase() ?? ""] ?? "Needs review";
}

export type WorkforcePayoutFilterSelection = {
  designations: readonly string[];
  locations: readonly string[];
  providers: readonly string[];
  methods: readonly string[];
  mappingStatuses: readonly string[];
  statuses: readonly string[];
  paymentStatuses?: readonly string[];
  holds?: readonly string[];
  readiness?: readonly string[];
  profiles?: readonly string[];
  models?: readonly string[];
  bankFiles?: readonly string[];
};

export const WORKFORCE_PAYOUT_FILTER_NONE = "__WORKFORCE_PAYOUT_FILTER_NONE__";

export function reconcileWorkforcePayoutFilterSelection(
  options: readonly string[],
  selected: readonly string[]
) {
  if (!selected.length || selected.includes(WORKFORCE_PAYOUT_FILTER_NONE)) return [...selected];
  const available = new Set(options);
  const retained = selected.filter((value) => available.has(value));
  if (!retained.length) return [];
  return retained.length === options.length && options.every((option) => retained.includes(option)) ? [] : retained;
}

function includesSelected(selected: readonly string[], value: string) {
  return selected.length === 0 || selected.includes(value);
}

export function workforcePayoutFacetValues(value: string) {
  return String(value ?? "").split(" / ").map((item) => item.trim()).filter(Boolean);
}

export function toggleWorkforcePayoutFilterOption(
  options: readonly string[],
  selected: readonly string[],
  value: string
) {
  const selectedOptions = selected.filter((option) => options.includes(option));
  const selectedSet = new Set(selectedOptions);
  const next = selected.length === 0
    ? options.filter((option) => option !== value)
    : selectedSet.has(value)
      ? selectedOptions.filter((option) => option !== value)
      : [...selectedOptions, value];
  if (!next.length) return [WORKFORCE_PAYOUT_FILTER_NONE];
  return next.length === options.length && options.every((option) => next.includes(option)) ? [] : next;
}

function includesSelectedFacet(selected: readonly string[], value: string) {
  return selected.length === 0 || workforcePayoutFacetValues(value).some((item) => selected.includes(item));
}

export function matchesWorkforcePayoutFilters(
  row: WorkforcePayoutFilterableRow,
  search: string,
  filters: WorkforcePayoutFilterSelection
) {
  const term = search.trim().toLowerCase();
  const matchesSearch = !term
    || `${row.dropxId} ${row.dropxStatus} ${row.name} ${row.providerMemberId} ${row.providerMemberName} ${row.designation} ${row.mappingStatus}`.toLowerCase().includes(term);
  const matchesMethod = filters.methods.length === 0
    || row.paymentMethodBreakdown.some((item) => filters.methods.includes(item.label));

  return matchesSearch
    && includesSelected(filters.designations, row.designation)
    && includesSelectedFacet(filters.locations, row.location)
    && includesSelectedFacet(filters.providers, row.provider)
    && matchesMethod
    && includesSelected(filters.mappingStatuses, row.mappingStatus)
    && includesSelected(filters.statuses, row.status)
    && includesSelected(filters.paymentStatuses ?? [], workforcePayoutPaymentStatus(row))
    && includesSelected(filters.holds ?? [], workforcePayoutHoldStatus(row))
    && includesSelected(filters.readiness ?? [], workforcePayoutReadiness(row))
    && includesSelected(filters.profiles ?? [], row.dropxStatus)
    && includesSelected(filters.bankFiles ?? [], row.bankFileStatus ?? "Not available")
    && includesSelectedFacet(filters.models ?? [], row.model ?? "");
}

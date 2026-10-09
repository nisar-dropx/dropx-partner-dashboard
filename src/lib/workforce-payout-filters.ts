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
};

export type WorkforcePayoutFilterSelection = {
  designations: readonly string[];
  locations: readonly string[];
  providers: readonly string[];
  methods: readonly string[];
  mappingStatuses: readonly string[];
  statuses: readonly string[];
};

export const WORKFORCE_PAYOUT_FILTER_NONE = "__WORKFORCE_PAYOUT_FILTER_NONE__";

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
    && includesSelected(filters.statuses, row.status);
}

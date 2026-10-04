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

function includesSelected(selected: readonly string[], value: string) {
  return selected.length === 0 || selected.includes(value);
}

export function workforcePayoutFacetValues(value: string) {
  return String(value ?? "").split(" / ").map((item) => item.trim()).filter(Boolean);
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

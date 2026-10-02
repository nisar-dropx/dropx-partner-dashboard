export type WorkforcePayoutFilterableRow = {
  dropxId: string;
  name: string;
  providerMemberId: string;
  providerMemberName: string;
  location: string;
  provider: string;
  status: string;
  paymentMethodBreakdown: Array<{ label: string }>;
};

export type WorkforcePayoutFilterSelection = {
  locations: readonly string[];
  providers: readonly string[];
  methods: readonly string[];
  statuses: readonly string[];
};

function includesSelected(selected: readonly string[], value: string) {
  return selected.length === 0 || selected.includes(value);
}

export function matchesWorkforcePayoutFilters(
  row: WorkforcePayoutFilterableRow,
  search: string,
  filters: WorkforcePayoutFilterSelection
) {
  const term = search.trim().toLowerCase();
  const matchesSearch = !term
    || `${row.dropxId} ${row.name} ${row.providerMemberId} ${row.providerMemberName}`.toLowerCase().includes(term);
  const matchesMethod = filters.methods.length === 0
    || row.paymentMethodBreakdown.some((item) => filters.methods.includes(item.label));

  return matchesSearch
    && includesSelected(filters.locations, row.location)
    && includesSelected(filters.providers, row.provider)
    && matchesMethod
    && includesSelected(filters.statuses, row.status);
}

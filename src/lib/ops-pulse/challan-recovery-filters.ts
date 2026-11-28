import type { ChallanRecoveryCase } from "@/lib/ops-pulse/challan-recovery";

export type ChallanRecoveryDimension = "station" | "status" | "month";
export type ChallanRecoveryFilters = Record<ChallanRecoveryDimension, string[]>;
export type ChallanRecoveryFacts = Record<ChallanRecoveryDimension, string[]>;

export const emptyChallanRecoveryFilters = (): ChallanRecoveryFilters => ({
  station: [],
  status: [],
  month: []
});

export function challanRecoveryFacts(row: ChallanRecoveryCase): ChallanRecoveryFacts {
  return {
    station: [row.stationCode || "Unmapped"],
    status: [row.status || "open"],
    month: [row.month || ""]
  };
}

export function matchesChallanRecoveryFilters(
  facts: ChallanRecoveryFacts,
  filters: ChallanRecoveryFilters,
  except?: ChallanRecoveryDimension
) {
  return (Object.keys(filters) as ChallanRecoveryDimension[]).every(
    (key) =>
      key === except ||
      !filters[key].length ||
      filters[key].some((value) => facts[key].includes(value))
  );
}

/** Options for one dimension after all OTHER filters (and search) are applied. Keeps selected zero-match values. */
export function challanRecoveryFacetOptions(
  facts: ChallanRecoveryFacts[],
  filters: ChallanRecoveryFilters,
  dimension: ChallanRecoveryDimension
) {
  return [
    ...new Set([
      ...filters[dimension],
      ...facts.filter((row) => matchesChallanRecoveryFilters(row, filters, dimension)).flatMap((row) => row[dimension])
    ])
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

const CASE_STATUS_LABELS: Record<string, string> = {
  open: "Unassigned",
  assigned: "Assigned",
  recovering: "Recovering",
  recovered: "Recovered",
  closed: "Closed",
  cancelled: "Cancelled"
};

const ALLOCATION_STATUS_LABELS: Record<string, string> = {
  planned: "Scheduled",
  scheduled: "Scheduled",
  draft: "Draft payroll",
  deducted: "Deducted",
  recovered: "Deducted",
  cancelled: "Cancelled",
  waived: "Waived"
};

export function challanRecoverySearchHaystack(row: ChallanRecoveryCase) {
  const people = row.allocations
    .map((a) => `${a.personName} ${a.personRef} ${a.utr} ${ALLOCATION_STATUS_LABELS[a.status] || a.status}`)
    .join(" ");
  return [
    row.challanNumber,
    row.vehicleNo,
    row.stationCode,
    row.offenseDescription,
    row.issuingAuthority,
    row.approvedByName,
    row.status,
    CASE_STATUS_LABELS[row.status] || row.status,
    row.month,
    people
  ]
    .join(" ")
    .toLowerCase();
}

export function filterChallanRecoveryCases(
  cases: ChallanRecoveryCase[],
  filters: ChallanRecoveryFilters,
  query: string
) {
  const needle = query.trim().toLowerCase();
  const searched = needle
    ? cases.filter((row) => challanRecoverySearchHaystack(row).includes(needle))
    : cases;
  const facts = searched.map(challanRecoveryFacts);
  return searched.filter((_, index) => matchesChallanRecoveryFilters(facts[index], filters));
}

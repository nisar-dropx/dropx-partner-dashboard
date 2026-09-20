import type { AdHocActivityStation } from "./adhoc-activity";

export const adHocSortKeys = [
  "station",
  "vanCount",
  "vanAmount",
  "daCount",
  "daAmount",
  "totalCount",
  "totalAmount"
] as const;

export type AdHocSortKey = typeof adHocSortKeys[number];
export type AdHocSortDirection = "asc" | "desc";

export function validAdHocSortKey(value: string | null | undefined): AdHocSortKey {
  return adHocSortKeys.includes(value as AdHocSortKey) ? value as AdHocSortKey : "totalAmount";
}

export function validAdHocSortDirection(value: string | null | undefined): AdHocSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export function sortAdHocStations(
  stations: AdHocActivityStation[],
  key: AdHocSortKey,
  direction: AdHocSortDirection
) {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...stations].sort((left, right) => {
    const comparison = key === "station"
      ? left.code.localeCompare(right.code)
      : left[key] - right[key];
    return comparison * multiplier || left.code.localeCompare(right.code);
  });
}

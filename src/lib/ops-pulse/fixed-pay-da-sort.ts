import type { FixedPayDaStation } from "./fixed-pay-da";

export const fixedPayDaSortKeys = [
  "station",
  "associates",
  "workedDays",
  "shipments",
  "salary",
  "cps",
  "pendingDays"
] as const;

export type FixedPayDaSortKey = typeof fixedPayDaSortKeys[number];
export type FixedPayDaSortDirection = "asc" | "desc";

export function validFixedPayDaSortKey(value: string | null | undefined): FixedPayDaSortKey {
  return fixedPayDaSortKeys.includes(value as FixedPayDaSortKey) ? value as FixedPayDaSortKey : "salary";
}

export function validFixedPayDaSortDirection(value: string | null | undefined): FixedPayDaSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export function sortFixedPayDaStations(
  stations: FixedPayDaStation[],
  key: FixedPayDaSortKey,
  direction: FixedPayDaSortDirection
) {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...stations].sort((left, right) => {
    const leftValue = key === "station" ? left.code : left[key];
    const rightValue = key === "station" ? right.code : right[key];
    const comparison = typeof leftValue === "string" && typeof rightValue === "string"
      ? leftValue.localeCompare(rightValue)
      : ((Number(leftValue) || 0) - (Number(rightValue) || 0));
    return comparison * multiplier || left.code.localeCompare(right.code);
  });
}

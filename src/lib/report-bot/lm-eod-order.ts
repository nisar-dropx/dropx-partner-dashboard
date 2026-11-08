type NumericRow = Record<string, string | number> & { Station: string };

const number = (value: string | number | undefined) => typeof value === "number" && Number.isFinite(value) ? value : 0;

const stationTieBreak = (left: NumericRow, right: NumericRow) => left.Station.localeCompare(right.Station);

/**
 * EOD tables are action queues. Keep the station with the largest unresolved
 * workload first instead of sorting alphabetically or rewarding the best KPI.
 */
export function orderEodDsrRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    (number(right.Assigned) - number(right.Delivered)) - (number(left.Assigned) - number(left.Delivered))
    || number(right["Delivery failed"]) - number(left["Delivery failed"])
    || stationTieBreak(left, right));
}

export function orderEodDotRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    (number(right.Eligible) - number(right.Delivered)) - (number(left.Eligible) - number(left.Delivered))
    || number(right["At station"]) - number(left["At station"])
    || stationTieBreak(left, right));
}

export function orderEodCReturnRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    number(right["Pending pickup"]) - number(left["Pending pickup"])
    || number(right.Total) - number(left.Total)
    || stationTieBreak(left, right));
}

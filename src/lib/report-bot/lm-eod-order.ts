type NumericRow = Record<string, string | number> & { Station: string };

const percentage = (value: string | number | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : -1;
};

const stationTieBreak = (left: NumericRow, right: NumericRow) => left.Station.localeCompare(right.Station);

export function orderEodDsrRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    percentage(right["DSR %"]) - percentage(left["DSR %"])
    || stationTieBreak(left, right));
}

export function orderEodDotRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    percentage(right["DOT %"]) - percentage(left["DOT %"])
    || stationTieBreak(left, right));
}

export function orderEodCReturnRows<T extends NumericRow>(rows: T[]) {
  return [...rows].sort((left, right) =>
    percentage(right["Pickup %"]) - percentage(left["Pickup %"])
    || stationTieBreak(left, right));
}

import { trendDates, trendNumber } from "./review-trends";

export type FuelPeriod = 7 | 14 | "mtd";
export type FuelEntry = {
  id: string;
  date: string;
  source: "card" | "portal";
  reference: string;
  provider: string;
  vehicle: string | null;
  amount: number;
  litres: number | null;
  note: string;
};
export type ReviewFuel = {
  station: string;
  date: string;
  available: boolean;
  latestCardDate: string | null;
  latestPortalDate: string | null;
  entries: FuelEntry[];
};
export type FuelRow = Record<string, unknown>;
export const fuelVehicle = (value: unknown) => {
  const text = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return text || null;
};
export function fuelDates(date: string, period: FuelPeriod) {
  return trendDates(date, period === "mtd" ? Number(date.slice(-2)) : period);
}
export function fuelFromDate(date: string) {
  return [fuelDates(date, 14)[0], `${date.slice(0, 7)}-01`].sort()[0];
}
function amount(row: FuelRow, keys: string[]) {
  for (const key of keys) {
    const value = trendNumber(row[key]);
    if (value != null) return value;
  }
  throw Error("A fuel record has no valid amount.");
}
// The caller supplies approved portal requests only. Card references are unique
// within their provider; identical amounts/dates alone are never a dedupe key.
export function buildReviewFuel(
  station: string,
  date: string,
  cards: FuelRow[],
  approved: FuelRow[],
  latestCardDate: string | null,
): ReviewFuel {
  const from = fuelFromDate(date),
    entries: FuelEntry[] = [],
    seen = new Set<string>();
  for (const row of cards) {
    const day = String(row.transaction_date ?? "");
    if (day < from || day > date) continue;
    const provider = String(row.provider ?? "Fuel card"),
      reference = String(row.transaction_id ?? row.id);
    const key = `${provider}:${reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cost = amount(row, ["amount"]),
      litres = trendNumber(row.litres);
    entries.push({
      id: `card:${key}`,
      date: day,
      source: "card",
      reference,
      provider,
      vehicle: fuelVehicle(row.vehicle_no),
      amount: cost,
      // The import historically wrote 0 for missing quantity. Do not claim 0L
      // consumption for a paid filling, or derive quantity from a guessed rate.
      litres:
        litres != null && litres > 0
          ? litres
          : cost === 0 && litres === 0
            ? 0
            : null,
      note: String(row.product ?? ""),
    });
  }
  let latestPortalDate: string | null = null;
  for (const row of approved) {
    const day = String(row.work_date ?? "");
    if (!day || day > date) continue;
    if (!latestPortalDate || day > latestPortalDate) latestPortalDate = day;
    if (day < from) continue;
    const details =
      row.details &&
      typeof row.details === "object" &&
      !Array.isArray(row.details)
        ? (row.details as FuelRow)
        : {};
    const key = `portal:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id: key,
      date: day,
      source: "portal",
      reference: String(row.request_no ?? row.id),
      provider: "Approved portal expense",
      vehicle: fuelVehicle(
        details.vehicle_no ??
          details.vehicle_number ??
          details.registration_number,
      ),
      amount: amount(row, ["amount_approved", "amount", "amount_requested"]),
      litres: null,
      note: String(row.remarks ?? row.notes ?? details.reason ?? ""),
    });
  }
  return {
    station,
    date,
    available: !!latestCardDate || !!latestPortalDate || entries.length > 0,
    latestCardDate,
    latestPortalDate,
    entries: entries.sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ),
  };
}
export function fuelTotals(entries: FuelEntry[]) {
  const cards = entries.filter((e) => e.source === "card"),
    portal = entries.filter((e) => e.source === "portal");
  const missingLitres = cards.some((e) => e.litres == null);
  return {
    card: cards.reduce((sum, e) => sum + e.amount, 0),
    portal: portal.reduce((sum, e) => sum + e.amount, 0),
    litres: missingLitres
      ? null
      : cards.reduce((sum, e) => sum + (e.litres ?? 0), 0),
    fills: cards.length,
    requests: portal.length,
    fillingDays: new Set(cards.map((e) => e.date)).size,
  };
}
export function fuelInDates(data: ReviewFuel, dates: string[]) {
  const selected = new Set(dates);
  return data.entries.filter((e) => selected.has(e.date));
}
export function fuelVehicleRows(data: ReviewFuel, dates: string[]) {
  const monthDates = fuelDates(data.date, "mtd"),
    include = new Set([...dates, ...monthDates]);
  const groups = new Map<
    string,
    {
      key: string;
      vehicle: string | null;
      source: FuelEntry["source"];
      entries: FuelEntry[];
    }
  >();
  for (const entry of data.entries) {
    if (!include.has(entry.date)) continue;
    const key = `${entry.source}:${entry.vehicle || "unrecorded"}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        vehicle: entry.vehicle,
        source: entry.source,
        entries: [],
      });
    groups.get(key)!.entries.push(entry);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      (a.vehicle ?? "~").localeCompare(b.vehicle ?? "~"),
  );
}

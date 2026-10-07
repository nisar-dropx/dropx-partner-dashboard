import type { CpsFacilityRent, CpsLine } from "./cps";

export type RentMasterRow = {
  id: string;
  site_code: string;
  allocation_station_code: string;
  monthly_rent: number | string;
  monthly_maintenance: number | string;
  effective_from: string;
  effective_to: string | null;
};
export const calendarDays = (date: string) =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();

// Explain the existing rent ledger; never add a second rent charge. Use only
// ledger dates, so scope, shipment cutoffs and effective rate changes are retained.
export function facilityRentDetails(records: RentMasterRow[], lines: CpsLine[]): CpsFacilityRent[] {
  const datesByStation = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.source !== "Finance Rent Master") continue;
    const dates = datesByStation.get(line.station_code) ?? new Set<string>();
    dates.add(line.work_date);
    datesByStation.set(line.station_code, dates);
  }
  const result: CpsFacilityRent[] = [];
  for (const record of records) {
    const dates = [...(datesByStation.get(record.allocation_station_code) ?? [])]
      .filter(d => d >= record.effective_from && (!record.effective_to || d <= record.effective_to)).sort();
    const periods = new Map<string, string[]>();
    for (const date of dates) {
      const month = date.slice(0, 7);
      periods.set(month, [...(periods.get(month) ?? []), date]);
    }
    for (const period of periods.values()) {
      const monthlyRent = Number(record.monthly_rent), maintenance = Number(record.monthly_maintenance);
      const denominator = calendarDays(period[0]);
      const monthly = monthlyRent + maintenance;
      // Match the Finance Rent Master ledger's cumulative paise rounding.
      const paise = period.reduce((sum, date) => {
        const day = Number(date.slice(8, 10));
        return sum + Math.round(monthly * 100 * day / denominator) - Math.round(monthly * 100 * (day - 1) / denominator);
      }, 0);
      result.push({ id: record.id, site_code: record.site_code,
        station_code: record.allocation_station_code, monthly_rent: monthlyRent,
        monthly_maintenance: maintenance, from_date: period[0], through_date: period.at(-1)!,
        days: period.length, calendar_days: denominator, amount: paise / 100 });
    }
  }
  return result.sort((a,b) => a.station_code.localeCompare(b.station_code) || a.from_date.localeCompare(b.from_date) || a.site_code.localeCompare(b.site_code));
}

export type CostItem = { key: string; label: string; source: string; amount: number; lines: CpsLine[] };
export type VanCostGroup = { key: string; label: string; amount: number; items: CostItem[] };

// Display grouping only. Existing master classifications and ledger amounts
// remain unchanged, and unfamiliar labels are retained under other vehicle costs.
function vanGroup(line: CpsLine): [string, string] {
  if (line.source === "Fleet Vehicle Master") return ["rental", "Vehicle rent"];
  if (line.source === "Fuel import" || /fuel|diesel|petrol/i.test(line.sub_head)) return ["fuel", "Fuel"];
  if (/ad[\s_-]?hoc|spot/i.test(line.sub_head)) return ["adhoc", "Ad hoc vehicles & drivers"];
  if (/maint[ae]nance|repair|service|tyre|tire/i.test(line.sub_head)) return ["maintenance", "Repairs & maintenance"];
  if (line.source === "Workforce rate card" || /driver|package/i.test(line.sub_head)) return ["driver", "Driver & delivery-linked pay"];
  return ["other", "Other vehicle costs"];
}
export function groupVanCosts(lines: CpsLine[]): VanCostGroup[] {
  const groups = new Map<string, VanCostGroup>();
  const items = new Map<string, CostItem>();
  for (const line of lines) {
    if (line.head !== "Van") continue;
    const [key, label] = vanGroup(line);
    const group = groups.get(key) ?? { key, label, amount: 0, items: [] };
    const itemKey = JSON.stringify([key, line.sub_head, line.source]);
    let item = items.get(itemKey);
    if (!item) {
      item = { key: itemKey, label: line.sub_head, source: line.source, amount: 0, lines: [] };
      items.set(itemKey, item);
      group.items.push(item);
    }
    item.lines.push(line);
    item.amount += Number(line.amount);
    group.amount += Number(line.amount);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.items.sort((a,b) => b.amount-a.amount || a.label.localeCompare(b.label));
  return [...groups.values()].sort((a,b) => b.amount-a.amount || a.label.localeCompare(b.label));
}

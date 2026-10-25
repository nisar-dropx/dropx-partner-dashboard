/** Single legacy values and compact multi-select values share the same deep links. */
export function lossFilterValues(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(lossFilterValues))];
  if (typeof value !== "string" || !value.trim()) return [];
  if (value.startsWith("[")) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? [...new Set(parsed.filter((v): v is string => typeof v === "string" && !!v))] : []; }
    catch { return []; }
  }
  return [value];
}
export function lossFilterValue(values: string[]) { return values.length > 1 ? JSON.stringify(values) : values[0] || ""; }
export function lossFilterMatches(filter: string | undefined, value: string) { const values = lossFilterValues(filter); return !values.length || values.includes(value); }
export const LOSS_SORTS = [
  { value: "value_desc", label: "Value · highest first" },
  { value: "value_asc", label: "Value · lowest first" },
  { value: "station_asc", label: "Station · A–Z" },
  { value: "station_desc", label: "Station · Z–A" },
  { value: "cases_desc", label: "Case count · highest first" },
] as const;
export function sortLossRows<T extends { amount: number | null; station_code: string; count?: number }>(rows: T[], sort: string = "value_desc") {
  return [...rows].sort((a,b) => {
    const station = a.station_code.localeCompare(b.station_code, undefined, { numeric: true });
    const value = Number(a.amount || 0) - Number(b.amount || 0);
    return (sort === "station_asc" ? station : sort === "station_desc" ? -station : sort === "value_asc" ? value : sort === "cases_desc" ? Number(b.count || 0) - Number(a.count || 0) : -value) || station || -value;
  });
}

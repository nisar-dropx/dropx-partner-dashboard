import {normalizeGpsPolicy,validateGpsPolicy,defaultGpsPolicy,type FleetGpsPolicy} from "./gps-policy";
export type FleetOperatingPolicy = {
  gps?: FleetGpsPolicy;
  stationVehicleTargets?: Record<string,number>;
  availabilityTargetPercent: number;
  serviceWorkTypes: string[];
};
export const defaultFleetOperatingPolicy: FleetOperatingPolicy = {
  gps: defaultGpsPolicy,
  availabilityTargetPercent: 90,
  serviceWorkTypes: ["Regular Service", "Preventive Maintenance", "Repair", "Breakdown Repair", "Tyre Work", "Oil Change", "Electrical / Battery", "Body / Accident Repair", "Inspection", "Other"]
};
export function normalizeFleetOperatingPolicy(value: unknown): FleetOperatingPolicy {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const target = Number(input.availabilityTargetPercent);
  const types = Array.isArray(input.serviceWorkTypes) ? [...new Set(input.serviceWorkTypes.map(v => String(v).trim()).filter(Boolean))] : [];
  return {
    stationVehicleTargets: input.stationVehicleTargets && typeof input.stationVehicleTargets === "object" ? Object.fromEntries(Object.entries(input.stationVehicleTargets).filter(([code,n])=>/^[A-Z0-9_-]{2,20}$/.test(code)&&Number.isInteger(n)&&Number(n)>=0&&Number(n)<=1000)) as Record<string,number> : {},
    gps: normalizeGpsPolicy(input.gps),
    availabilityTargetPercent: Number.isFinite(target) && target >= 1 && target <= 100 ? target : 90,
    serviceWorkTypes: types.length ? types.slice(0, 40).map(v => v.slice(0, 80)) : [...defaultFleetOperatingPolicy.serviceWorkTypes]
  };
}
export function operatingPolicyFromSettings(value: unknown) {
  const weights = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return normalizeFleetOperatingPolicy(weights.operating_policy);
}
export function validateFleetOperatingPolicy(value: unknown): FleetOperatingPolicy {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const target = Number(input.availabilityTargetPercent);
  if (!Number.isFinite(target) || target < 1 || target > 100) throw new Error("Availability target must be between 1 and 100%.");
  if (!Array.isArray(input.serviceWorkTypes) || !input.serviceWorkTypes.length || input.serviceWorkTypes.length > 40 || input.serviceWorkTypes.some(v => typeof v !== "string" || !v.trim() || v.trim().length > 80)) throw new Error("Enter 1–40 work categories, one per line (up to 80 characters each).");
  if(input.stationVehicleTargets!==undefined && (!input.stationVehicleTargets || typeof input.stationVehicleTargets!=="object" || Array.isArray(input.stationVehicleTargets) || Object.entries(input.stationVehicleTargets).some(([code,n])=>!(/^[A-Z0-9_-]{2,20}$/.test(code))||!Number.isInteger(n)||Number(n)<0||Number(n)>1000))) throw new Error("Station targets need a valid station code and 0–1,000 whole vehicles.");
  if(input.gps!==undefined)validateGpsPolicy(input.gps);
  return normalizeFleetOperatingPolicy(input);
}
export function policyDays(value: unknown, label: string) {
  const days = Number(value);
  if (value == null || String(value).trim() === "" || !Number.isInteger(days) || days < 1 || days > 365) throw new Error(`${label} must be 1–365 whole days.`);
  return days;
}
/** Earliest pending plan, regardless of the source query's ordering. */
export function nextServicePlans<T extends { vehicleId: string; status: string; serviceDate: string }>(records: T[]) {
  const plans = new Map<string, T>();
  for (const row of records) if (row.status === "scheduled" && (!plans.has(row.vehicleId) || row.serviceDate < plans.get(row.vehicleId)!.serviceDate)) plans.set(row.vehicleId, row);
  return plans;
}
export function reportDateRangeError(from: string, to: string): string | null {
  const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(from) || !valid(to)) return "Choose both report dates.";
  if (from > to) return "From date must be on or before To date.";
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 365) return "Choose up to 366 days per export.";
  return null;
}

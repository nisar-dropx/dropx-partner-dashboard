export const vehicleSources = ["own", "odcd", "rented"] as const;
export function sourceApplies(rule: { ownershipTypes?: string[] }, source: string) {
  return (rule.ownershipTypes ?? [...vehicleSources] as string[]).includes(source === "leased" ? "rented" : source);
}
export function documentApplies(rule: { value: string; ownershipTypes?: string[] }, vehicle: { ownershipType: string; fuelType: string }) {
  return sourceApplies(rule, vehicle.ownershipType) && !(rule.value === "FLEET_PUC" && /^(ev|electric)$/i.test(vehicle.fuelType));
}
export function deploymentDateError(value: unknown, today: string): string | null {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return "Enter a valid deployment date.";
  return date > today ? "Deployment date cannot be in the future." : null;
}

import { vehicleIsTerminal, type VehicleStatusPolicy } from "./vehicle-status-policy";
export type StationContact = { id: string; name: string; role: string; phone: string; isTeamLead: boolean };
export type StationContacts = { code: string; name: string; region: string; cluster: string; address: string; latitude: number | null; longitude: number | null; team: StationContact[] };
export type SummaryVehicle = { id: string; stationCode: string; ownershipType: string; status: string; model: string };
export function ownedStationGroups(vehicles: SummaryVehicle[], policies: VehicleStatusPolicy[] = []) {
  const groups = new Map<string, { code: string; total: number; models: Record<string, number> }>();
  for (const vehicle of vehicles) {
    if (vehicle.ownershipType !== 'own' || vehicleIsTerminal(vehicle.status, policies)) continue;
    const code = vehicle.stationCode.trim().toUpperCase();
    if (!code || code === 'UNASSIGNED') continue;
    const group = groups.get(code) ?? { code, total: 0, models: {} };
    group.total++;
    const model = vehicle.model.trim() || 'Model not recorded';
    group.models[model] = (group.models[model] ?? 0) + 1;
    groups.set(code, group);
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
}
export function stationMapUrl(latitude: number | null, longitude: number | null) {
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

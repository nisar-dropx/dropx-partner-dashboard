import { vehicleTypeLabel } from "./vehicle-type";
export type VehicleSourcePolicy = 'own' | 'odcd' | 'rented';
export type FleetVehicleSource = {
  id: string; designationId: string | null; code: string; name: string;
  ownershipType: VehicleSourcePolicy; isActive: boolean; sortOrder: number;
};
export type FleetSourceDesignation = { id: string; code: string; name: string; isActive: boolean };
export function sourceTitle(source: Pick<FleetVehicleSource, 'code' | 'name'>) {
  return source.code === 'OWN' ? source.name : `${source.code} · ${source.name}`;
}
export function vehicleSourceTitle(vehicle: { sourceCode?: string; sourceName?: string; ownershipType: string }) {
  return vehicleTypeLabel(vehicle);
}

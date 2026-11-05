/** Vehicle type is the configured source, not the model or fuel type. */
export type VehicleTypeMetadata = { sourceId?: string | null; sourceCode?: string | null; sourceName?: string | null; ownershipType?: string | null };
export function vehicleTypeKey(vehicle?: VehicleTypeMetadata | null) {
  return vehicle?.sourceId ? `source:${vehicle.sourceId}` : vehicle?.sourceCode ? `code:${vehicle.sourceCode}` : vehicle?.ownershipType ? `ownership:${vehicle.ownershipType}` : 'unknown';
}
export function vehicleTypeLabel(vehicle?: VehicleTypeMetadata | null) {
  if (!vehicle) return 'Type not recorded';
  const code = vehicle.sourceCode?.trim().toUpperCase();
  if (code === 'OWN' || (!code && !vehicle.sourceName && vehicle.ownershipType === 'own')) return 'DropX owned';
  if (code === 'ODCD') return 'ODCD';
  if (code === 'VNV') return 'Van Vendor';
  if (code === 'VAN') return 'Van Rented';
  if (vehicle.sourceName?.trim()) return vehicle.sourceName.trim();
  if (vehicle.ownershipType === 'odcd') return 'ODCD';
  // A legacy rented ownership alone cannot distinguish rented vans from vendors.
  if (vehicle.ownershipType === 'rented') return 'Rented / vendor · type not mapped';
  return 'Type not recorded';
}
export function matchesVehicleType(vehicle: VehicleTypeMetadata | null | undefined, values: string[]) {
  return !values.length || values.includes(vehicleTypeKey(vehicle));
}
export function vehicleTypeOptions(vehicles: VehicleTypeMetadata[]) {
  return [...new Map(vehicles.map(v => [vehicleTypeKey(v), { value: vehicleTypeKey(v), label: vehicleTypeLabel(v) }])).values()].sort((a,b) => a.label.localeCompare(b.label));
}

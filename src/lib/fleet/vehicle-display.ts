type VehicleDisplay = {
  vehicleNo: string;
  ownershipType?: string | null;
  daName?: string | null;
  vendorName?: string | null;
  model?: string | null;
  stationCode?: string | null;
};

export function vehicleRegistrationMissing(vehicle: VehicleDisplay) {
  return !vehicle.vehicleNo.trim() || /^PENDING-/i.test(vehicle.vehicleNo.trim());
}

/** Display only: keep the original registry identifier for GPS and history joins. */
export function vehicleDisplayName(vehicle: VehicleDisplay) {
  if (!vehicleRegistrationMissing(vehicle)) return vehicle.vehicleNo;
  const contact = vehicle.ownershipType === 'own' ? '' : vehicle.daName?.trim() || vehicle.vendorName?.trim();
  return contact || vehicle.model?.trim() || 'Vehicle';
}

export function vehicleDisplayDetail(vehicle: VehicleDisplay) {
  return [vehicle.model?.trim() || 'Model not recorded', vehicle.stationCode || 'Station not mapped', vehicleRegistrationMissing(vehicle) ? 'Registration not added' : null].filter(Boolean).join(' · ');
}

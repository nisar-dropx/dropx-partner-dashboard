/** Shared by live availability, service reports and the scheduled email. */
export type VehicleStatusPolicy = { key: string; isOperational: boolean; isTerminal: boolean };

export function vehicleStatusKey(value: unknown) {
  const key = String(value || 'active').trim().toLowerCase();
  return ['repair', 'service'].includes(key) ? 'under_service' : key;
}

export function vehicleIsOperational(value: unknown, policies: VehicleStatusPolicy[]) {
  const key = vehicleStatusKey(value);
  return policies.find(policy => policy.key === key)?.isOperational ?? key === 'active';
}

export function vehicleIsTerminal(value: unknown, policies: VehicleStatusPolicy[]) {
  const key = vehicleStatusKey(value);
  // Archived records remain excluded even if a status master is changed.
  return key === 'archived' || (policies.find(policy => policy.key === key)?.isTerminal
    ?? ['sold', 'disposed', 'returned'].includes(key));
}

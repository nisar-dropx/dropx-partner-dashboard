export type AdhocRule = {
  reason_key: string;
  label: string;
  source_code: string | null;
  required_status: string | null;
  required_statuses?: string[] | null;
  effect_status: string | null;
  block_rent: boolean;
  approval_steps: unknown;
  contact_role_code: string | null;
};
export type AdhocVehicle = {
  id: string;
  number: string;
  model: string;
  partner: string;
  source: string;
  status: string;
  deploymentDate: string;
  unavailable: boolean;
  // Derived from the company Fleet status master, never inferred from GPS/location.
  replacementEligible?: boolean;
  locationType?: string | null;
  gpsKm?: number | null;
};
export type AdhocContext = { rules: AdhocRule[]; vehicles: AdhocVehicle[]; contact: string | null };

export type AdhocOutOnRoadEvidence = 'fleet_status';

export function normalizeAdhocVehicleNo(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isBreakdownVehicleReason(rule: Pick<AdhocRule, 'reason_key'> | null | undefined): boolean {
  return Boolean(rule && ['company_breakdown', 'vendor_breakdown', 'odcd_breakdown', 'breakdown_vehicle'].includes(rule.reason_key));
}

export function usesAdhocVehicleDropdown(rule: Pick<AdhocRule, 'reason_key' | 'source_code'> | null | undefined): boolean {
  return Boolean(rule?.source_code);
}

export function eligibleAdhocVehicles(rule: AdhocRule, vehicles: AdhocVehicle[], date: string) {
  return vehicles.filter(
    (v) =>
      v.source === rule.source_code &&
      (!v.deploymentDate || v.deploymentDate <= date) &&
      (isBreakdownVehicleReason(rule)
        ? v.replacementEligible === true
        : !requiredAdhocStatuses(rule).length || requiredAdhocStatuses(rule).includes(v.status)) &&
      !v.unavailable
  );
}

export function requiredAdhocStatuses(rule: AdhocRule): string[] {
  return rule.required_statuses ?? (rule.required_status ? [rule.required_status] : []);
}

export function isAdhocReplacementStatus(state: {
  is_active: boolean;
  is_operational: boolean;
  is_terminal: boolean;
} | null | undefined): boolean {
  return state?.is_active === true && state.is_operational === false && state.is_terminal === false;
}

export function adhocStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function adhocVehicleLabel(vehicle: {
  source: string;
  partner: string | null;
  number: string;
  model: string;
  status: string;
}): string {
  const registration = !vehicle.number || /^PENDING-/i.test(vehicle.number) ? 'Registration not added' : vehicle.number;
  const partner =
    vehicle.source === 'OWN'
      ? null
      : vehicle.partner || (vehicle.source === 'ODCD' ? 'DA name not added' : 'Vendor name not added');
  return [partner, vehicle.model, registration, adhocStatusLabel(vehicle.status)].filter(Boolean).join(' · ');
}

/** Compatibility lookup: Fleet must classify the status as non-operational and non-terminal. */
export function evaluateAdhocOutOnRoad(vehicle: {
  status: string;
  locationType?: string | null;
  gpsKm?: number | null;
  unavailable?: boolean;
  replacementEligible?: boolean;
}): { ok: boolean; evidence: AdhocOutOnRoadEvidence | null; error: string | null } {
  if (vehicle.unavailable) {
    return { ok: false, evidence: null, error: 'A replacement request already exists for this vehicle and date.' };
  }
  if (vehicle.replacementEligible === true) {
    return { ok: true, evidence: 'fleet_status', error: null };
  }
  return {
    ok: false,
    evidence: null,
    error:
      'Vehicle must be marked non-operational in Fleet before requesting a replacement.',
  };
}

export function adhocOutOnRoadEvidenceLabel(_evidence: AdhocOutOnRoadEvidence, status: string): string {
  return `Fleet status: ${adhocStatusLabel(status)}`;
}

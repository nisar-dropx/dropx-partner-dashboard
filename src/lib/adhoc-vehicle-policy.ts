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
      (!requiredAdhocStatuses(rule).length || requiredAdhocStatuses(rule).includes(v.status)) &&
      !v.unavailable
  );
}

export function requiredAdhocStatuses(rule: AdhocRule): string[] {
  if (isBreakdownVehicleReason(rule)) return ['breakdown'];
  return rule.required_statuses ?? (rule.required_status ? [rule.required_status] : []);
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

/** Compatibility lookup: only Fleet Breakdown status qualifies, never GPS or location. */
export function evaluateAdhocOutOnRoad(vehicle: {
  status: string;
  locationType?: string | null;
  gpsKm?: number | null;
  unavailable?: boolean;
}): { ok: boolean; evidence: AdhocOutOnRoadEvidence | null; error: string | null } {
  if (vehicle.unavailable) {
    return { ok: false, evidence: null, error: 'A replacement request already exists for this vehicle and date.' };
  }
  if (vehicle.status === 'breakdown') {
    return { ok: true, evidence: 'fleet_status', error: null };
  }
  return {
    ok: false,
    evidence: null,
    error:
      'Vehicle must be marked Breakdown in Fleet before requesting a replacement.',
  };
}

export function adhocOutOnRoadEvidenceLabel(_evidence: AdhocOutOnRoadEvidence): string {
  return 'Fleet status: Breakdown';
}

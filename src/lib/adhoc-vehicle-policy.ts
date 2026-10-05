export type AdhocRule = { reason_key: string; label: string; source_code: string | null; required_status: string | null; required_statuses?: string[] | null; effect_status: string | null; block_rent: boolean; approval_steps: unknown; contact_role_code: string | null };
export type AdhocVehicle = { id: string; number: string; model: string; partner: string; source: string; status: string; deploymentDate: string; unavailable: boolean };
export type AdhocContext = { rules: AdhocRule[]; vehicles: AdhocVehicle[]; contact: string | null };
export function eligibleAdhocVehicles(rule: AdhocRule, vehicles: AdhocVehicle[], date: string) {
 return vehicles.filter(v => v.source === rule.source_code && (!v.deploymentDate || v.deploymentDate <= date) && (!requiredAdhocStatuses(rule).length || requiredAdhocStatuses(rule).includes(v.status)) && !v.unavailable);
}

export function requiredAdhocStatuses(rule: AdhocRule): string[] {
 return rule.required_statuses ?? (rule.required_status ? [rule.required_status] : []);
}
export function adhocStatusLabel(status: string): string {
 return status.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
export function adhocVehicleLabel(vehicle: {source: string; partner: string | null; number: string; model: string; status: string}): string {
 const registration = !vehicle.number || /^PENDING-/i.test(vehicle.number) ? 'Registration not added' : vehicle.number;
 const partner = vehicle.source === 'OWN' ? null : vehicle.partner || (vehicle.source === 'ODCD' ? 'DA name not added' : 'Vendor name not added');
 return [partner, vehicle.model, registration, adhocStatusLabel(vehicle.status)].filter(Boolean).join(' · ');
}

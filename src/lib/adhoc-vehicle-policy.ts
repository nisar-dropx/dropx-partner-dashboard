export type AdhocRule = { reason_key: string; label: string; source_code: string | null; required_status: string | null; effect_status: string | null; block_rent: boolean; approval_steps: unknown; contact_role_code: string | null };
export type AdhocVehicle = { id: string; number: string; model: string; partner: string; source: string; status: string; deploymentDate: string; unavailable: boolean };
export type AdhocContext = { rules: AdhocRule[]; vehicles: AdhocVehicle[]; contact: string | null };
export function eligibleAdhocVehicles(rule: AdhocRule, vehicles: AdhocVehicle[], date: string) {
 return vehicles.filter(v => v.source === rule.source_code && (!v.deploymentDate || v.deploymentDate <= date) && (!rule.required_status || v.status === rule.required_status) && !v.unavailable);
}

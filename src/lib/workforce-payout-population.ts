import { workforceProfileStatus } from "./workforce-register-policy.ts";

export type WorkforcePayoutShipmentIdentity = {
  provider_employee_id?: string | null;
  provider_employee_name?: string | null;
  work_date?: string | null;
  station_code?: string | null;
  client?: string | null;
};

export type WorkforcePayoutMappingIdentity = {
  id: string;
  providerMemberId: string;
  stationCode: string;
  providerIdentity: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  workforceId: string;
  paymentMethodId: string;
};

export type WorkforcePayoutMappingSourceIdentity = {
  workforce_id?: string | null;
  contractor_id?: string | null;
  employee_id?: string | null;
  field_executive_id?: string | null;
};

export type WorkforcePayoutCanonicalIdentity = {
  id?: string | null;
  source_profile_id?: string | null;
};

export type WorkforcePayoutMappingResolution = {
  kind: "mapped" | "unmapped" | "conflict";
  workforceId: string;
  matches: WorkforcePayoutMappingIdentity[];
};

export type WorkforcePayoutStatusSource = {
  onboarding_status?: string | null;
  lifecycle_status?: string | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
};

export function normalizePayoutIdentity(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function shipmentIdentityKey(row: WorkforcePayoutShipmentIdentity) {
  return [row.station_code, row.client, row.provider_employee_id]
    .map(normalizePayoutIdentity)
    .join("|");
}

/**
 * Returns every effective mapping that belongs to an already-authorized
 * canonical worker. This is used only to calculate hidden month-to-date
 * threshold carry-in after a station transfer; callers still render and
 * expose only their location-scoped mappings.
 */
export function mappingsForAuthorizedWorkforce<T extends WorkforcePayoutMappingSourceIdentity>(
  mappings: readonly T[],
  workers: readonly WorkforcePayoutCanonicalIdentity[]
) {
  const authorizedIdentityIds = new Set(workers.flatMap((worker) => [worker.id, worker.source_profile_id])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean));
  return mappings.filter((mapping) => [
    mapping.workforce_id,
    mapping.contractor_id,
    mapping.employee_id,
    mapping.field_executive_id
  ].some((value) => authorizedIdentityIds.has(String(value ?? "").trim())));
}

export function payoutMappingMatchesShipment(
  mapping: WorkforcePayoutMappingIdentity,
  shipment: WorkforcePayoutShipmentIdentity
) {
  const date = String(shipment.work_date ?? "");
  const memberId = normalizePayoutIdentity(shipment.provider_employee_id);
  const stationCode = normalizePayoutIdentity(shipment.station_code);
  const client = normalizePayoutIdentity(shipment.client);
  return Boolean(date && memberId)
    && normalizePayoutIdentity(mapping.providerMemberId) === memberId
    && mapping.effectiveFrom <= date
    && (!mapping.effectiveTo || mapping.effectiveTo >= date)
    && (!mapping.stationCode || normalizePayoutIdentity(mapping.stationCode) === stationCode)
    && (!client || normalizePayoutIdentity(mapping.providerIdentity).includes(client));
}

export function resolveShipmentPayoutMapping(
  shipment: WorkforcePayoutShipmentIdentity,
  mappings: WorkforcePayoutMappingIdentity[]
): WorkforcePayoutMappingResolution {
  const matches = mappings.filter((mapping) => payoutMappingMatchesShipment(mapping, shipment));
  if (!matches.length) return { kind: "unmapped", workforceId: "", matches };
  const workforceIds = [...new Set(matches.map((mapping) => mapping.workforceId).filter(Boolean))];
  if (workforceIds.length !== 1 || matches.some((mapping) => !mapping.workforceId)) {
    return { kind: "conflict", workforceId: "", matches };
  }
  return { kind: "mapped", workforceId: workforceIds[0], matches };
}

export function workforcePayoutDropxStatus(source?: WorkforcePayoutStatusSource | null) {
  return workforceProfileStatus(source);
}

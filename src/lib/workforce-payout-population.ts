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

function humanizeStatus(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function workforcePayoutDropxStatus(source?: WorkforcePayoutStatusSource | null) {
  if (!source) return "";
  if (source.deleted_at) return "Inactive";
  const lifecycle = String(source.lifecycle_status ?? "").trim().toLowerCase();
  if (lifecycle && lifecycle !== "active" && lifecycle !== "onboarding") return humanizeStatus(lifecycle);
  const onboarding = String(source.onboarding_status ?? "").trim().toLowerCase();
  if (onboarding && onboarding !== "active") return humanizeStatus(onboarding);
  return source.is_active === true ? "Active" : "Inactive";
}

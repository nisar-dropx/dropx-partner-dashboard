export type FleetPaymentHead = {
  code?: string | null;
  name?: string | null;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function isAdHocPaymentHead(head: FleetPaymentHead) {
  const candidate = normalized(`${head.code ?? ""} ${head.name ?? ""}`);
  return /(^|_)AD_?HOC(_|$)/.test(candidate) || /(^|_)ADHOC(_|$)/.test(candidate);
}

export function isFleetManagerPaymentHead(head: FleetPaymentHead) {
  const candidate = normalized(`${head.code ?? ""} ${head.name ?? ""}`);

  // Ad-hoc capacity belongs to Operations. Fleet sees the usage but never acts on it.
  if (isAdHocPaymentHead(head)) return false;

  return /(^|_)(VEHICLE|VAN|FLEET|TYRE|TIRE|PUC)(_|$)/.test(candidate)
    || /(VEHICLE|VAN|FLEET).*(FUEL|RENT|DRIVER|MAINTENANCE|REPAIR|SERVICE|INSURANCE|PERMIT|TAX)/.test(candidate)
    || /(FUEL|RENT|DRIVER|MAINTENANCE|REPAIR|SERVICE|INSURANCE|PERMIT|TAX).*(VEHICLE|VAN|FLEET)/.test(candidate);
}

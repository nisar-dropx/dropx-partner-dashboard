function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedFuelType(value: unknown) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const pureElectricFuelTypes = new Set([
  "ev",
  "bev",
  "pure ev",
  "electric",
  "electric bov",
  "battery electric vehicle",
  "battery operated vehicle"
]);

export function isPureElectricFuel(value: unknown) {
  return pureElectricFuelTypes.has(normalizedFuelType(value));
}

export function normalizeVehicleRegistration(value: unknown) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type VehicleVerificationAudit = {
  is_success?: boolean | null;
  request_data?: unknown;
  request_status?: string | null;
  response_data?: unknown;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function trustedVehicleFuelFromAudits(
  audits: VehicleVerificationAudit[],
  registrationNumber: unknown
) {
  const expectedRegistration = normalizeVehicleRegistration(registrationNumber);
  if (!expectedRegistration) return "";

  for (const audit of audits) {
    const request = record(audit.request_data);
    const auditedRegistration = normalizeVehicleRegistration(request.reg_no ?? request.regNo);
    if (auditedRegistration !== expectedRegistration) continue;

    const requestStatus = text(audit.request_status).toLowerCase();
    if (requestStatus !== "completed" || audit.is_success !== true) return "";

    const response = record(audit.response_data);
    const status = record(response.status);
    const providerSucceeded = text(status.type).toLowerCase() === "success" || response.success === true;
    if (!providerSucceeded) return "";

    const data = record(response.data);
    return text(data.type ?? data.fuel_type ?? data.fuelType);
  }

  return "";
}

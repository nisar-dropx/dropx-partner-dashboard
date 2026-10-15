export type ProviderAttendanceOwnershipMapping = {
  id: string;
  workforceId: string;
  stationId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  setupSignature: string;
};

export type ProviderAttendanceSetupComponent = {
  code: unknown;
  paySchedule: unknown;
  calculationType: unknown;
  calculationSource: unknown;
  rate: unknown;
};

export function providerAttendanceLocationKey(workforceId: unknown, stationId: unknown, date: unknown) {
  return `${String(workforceId ?? "")}|${String(stationId ?? "")}|${String(date ?? "")}`;
}

export function providerAttendanceWorkerDateKey(workforceId: unknown, date: unknown) {
  return `${String(workforceId ?? "")}|${String(date ?? "")}`;
}

export function providerAttendanceRecordForStation<T>(input: {
  located: ReadonlyMap<string, T>;
  unlocated: ReadonlyMap<string, T>;
  workforceId: string;
  stationId: string;
  date: string;
  unlocatedOwnerStationId: string;
}) {
  const located = input.located.get(providerAttendanceLocationKey(input.workforceId, input.stationId, input.date));
  if (located !== undefined) return located;
  return input.unlocatedOwnerStationId === input.stationId
    ? input.unlocated.get(providerAttendanceWorkerDateKey(input.workforceId, input.date))
    : undefined;
}

function normalizedRate(value: unknown) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value).trim();
}

export function providerAttendanceSetupSignature(components: ProviderAttendanceSetupComponent[]) {
  return JSON.stringify(components
    .map((component) => [
      String(component.code ?? "").trim().toUpperCase(),
      String(component.paySchedule ?? ""),
      String(component.calculationType ?? ""),
      String(component.calculationSource ?? ""),
      normalizedRate(component.rate)
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function providerAttendanceOwnerOn(
  mappings: ProviderAttendanceOwnershipMapping[],
  workforceId: string,
  stationId: string,
  date: string
) {
  const candidates = mappings
    .filter((mapping) => mapping.workforceId === workforceId
      && mapping.stationId === stationId
      && mapping.effectiveFrom <= date
      && (!mapping.effectiveTo || mapping.effectiveTo >= date))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom)
      || right.id.localeCompare(left.id));
  if (!candidates.length) return { ownerId: "", conflict: false } as const;

  const latest = candidates.filter((candidate) => candidate.effectiveFrom === candidates[0].effectiveFrom);
  if (new Set(latest.map((candidate) => candidate.setupSignature)).size > 1) {
    return { ownerId: "", conflict: true } as const;
  }
  return { ownerId: latest[0].id, conflict: false } as const;
}

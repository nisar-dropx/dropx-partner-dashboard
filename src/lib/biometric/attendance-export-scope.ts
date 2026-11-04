/** Parse repeated location_id query values and keep only ids in the caller's scope. */
export function resolveAttendanceExportLocationIds(requested: string[], allowedLocationIds: string[]) {
  const allowed = new Set(allowedLocationIds);
  const selected = [...new Set(requested.map((value) => String(value ?? "").trim()).filter(Boolean))];
  const outOfScope = selected.filter((id) => !allowed.has(id));
  if (outOfScope.length) {
    return { ok: false as const, outOfScope, locationIds: [] as string[] };
  }
  return {
    ok: true as const,
    outOfScope: [] as string[],
    locationIds: selected.length ? selected : [...allowedLocationIds]
  };
}

/** Keep one monthly Excel row per person+station so multi-station people do not collapse. */
export function attendanceExportWorkerStationKey(input: {
  workerCode: string;
  workerName: string;
  designation: string;
  location: string;
}) {
  return `${input.workerCode}|${input.workerName}|${input.designation}|${input.location || "-"}`;
}

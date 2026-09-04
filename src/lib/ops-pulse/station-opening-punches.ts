export type OpeningPunch = {
  locationId: string;
  time: string;
  enrolmentId: string;
  employeeId?: string | null;
  fieldExecutiveId?: string | null;
  profileType?: string | null;
  accountId?: string | null;
  name?: string | null;
  workerCode?: string | null;
};

export type PhysicalPunch = {
  device_id: string | null;
  device_serial: string | null;
  location_id: string | null;
  source: string | null;
  geofence_status: string | null;
};

export function physicalPunchLocation(
  punch: PhysicalPunch,
  deviceLocations: Map<string, string>,
  serialLocations: Map<string, string>
) {
  if (punch.source === "app_gps") {
    return punch.geofence_status === "inside" ? punch.location_id : null;
  }
  // Biometric location_id is the worker assignment, not where the device is.
  // Unknown devices must never inherit that assignment or its parent station.
  if (punch.device_id) return deviceLocations.get(punch.device_id) ?? null;
  return punch.device_serial ? serialLocations.get(punch.device_serial) ?? null : null;
}

export function firstOpeningPunches(
  punches: OpeningPunch[],
  windows: Map<string, { start: string; end: string }>
) {
  const first = new Map<string, OpeningPunch>();
  for (const punch of [...punches].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    const window = windows.get(punch.locationId);
    if (!window || first.has(punch.locationId) || !Number.isFinite(Date.parse(punch.time))) continue;
    const localTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit"
    }).format(new Date(punch.time));
    const start = window.start.slice(0, 5);
    const end = window.end.slice(0, 5);
    const within = start <= end ? localTime >= start && localTime <= end : localTime >= start || localTime <= end;
    if (within) first.set(punch.locationId, punch);
  }
  return first;
}

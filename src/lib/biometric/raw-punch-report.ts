export type RawPunchRow = {
  created_at: string;
  device_id: string | null;
  device_serial: string;
  employee_code?: string | null;
  enrolment_id: string | null;
  event_type: string | null;
  id: string;
  punch_time: string | null;
  received_at: string | null;
  source_ip: string | null;
  terminal_id: string | null;
  trans_id: string | null;
  worker_status: string | null;
  payload?: Record<string, unknown> | null;
};

/** Source evidence is not a verified physical device/location or an attendance decision. */
export function rawPunchSourceDetails(row: RawPunchRow) {
  const payload = row.payload ?? {};
  const isTeamOffice = row.device_serial === "ETIMEOFFICE" || payload.source === "eTime Office portal";
  const sourceText = (key: string) => typeof payload[key] === "string" ? payload[key] as string : "";
  const possibleOverlapCount = Array.isArray(payload.possible_middleware_matches) ? payload.possible_middleware_matches.length : 0;
  return {
    isTeamOffice,
    label: isTeamOffice ? "Team Office" : "Device / middleware",
    employeeCode: row.employee_code || sourceText("portal_employee_code"),
    recordId: sourceText("portal_record_id"),
    machine: sourceText("portal_machine"),
    possibleOverlapCount,
    note: isTeamOffice
      ? `Team Office source record (minute precision); machine label is unverified.${possibleOverlapCount ? " Possible same-minute middleware overlap; retained as source evidence." : ""}`
      : ""
  };
}

export type RawPunchDeviceRow = {
  device_no: string | null;
  device_serial: string;
  id: string;
  last_source_ip: string | null;
  local_ip_address: string | null;
  location_id: string | null;
  model: string | null;
  terminal_id: string | null;
};

export type RawPunchResultRow = {
  account_id: string | null;
  calculated: boolean;
  employee_id: string | null;
  field_executive_id: string | null;
  profile_type: string | null;
  raw_event_id: string | null;
  worker_status: string | null;
};

export type RawPunchAlertRow = {
  alert_type: string;
  message: string | null;
  raw_event_id: string | null;
};

export type RawPunchWorkerRow = {
  code: string | null;
  full_name: string | null;
  id: string;
};

export const RAW_PUNCH_PROFILE_TABLES: Record<string, { code: string; tables: string[] }> = {
  employee: { tables: ["employees"], code: "employee_code" },
  field_executive: { tables: ["workforce"], code: "dropx_id" },
  contractor: { tables: ["contractors"], code: "dropx_id" },
  vendor: { tables: ["vendors"], code: "dropx_id" },
  worker: { tables: ["workforce_helpers", "workforce_pickers"], code: "dropx_id" }
};

type DeviceMatch = "device_id" | "network" | "serial" | "terminal";

type DeviceIndex = {
  byId: Map<string, RawPunchDeviceRow>;
  byNetwork: Map<string, RawPunchDeviceRow>;
  bySerial: Map<string, RawPunchDeviceRow>;
  byTerminal: Map<string, RawPunchDeviceRow>;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueLookup(
  devices: RawPunchDeviceRow[],
  values: (device: RawPunchDeviceRow) => Array<string | null>
) {
  const candidates = new Map<string, RawPunchDeviceRow[]>();
  devices.forEach((device) => {
    Array.from(new Set(values(device).map(normalized).filter(Boolean))).forEach((value) => {
      const existing = candidates.get(value) ?? [];
      existing.push(device);
      candidates.set(value, existing);
    });
  });
  const unique = new Map<string, RawPunchDeviceRow>();
  candidates.forEach((matches, value) => {
    if (matches.length === 1) unique.set(value, matches[0]);
  });
  return unique;
}

export function buildRawPunchDeviceIndex(devices: RawPunchDeviceRow[]): DeviceIndex {
  return {
    byId: new Map(devices.map((device) => [device.id, device])),
    byNetwork: uniqueLookup(devices, (device) => [device.last_source_ip, device.local_ip_address]),
    bySerial: uniqueLookup(devices, (device) => [device.device_serial]),
    byTerminal: uniqueLookup(devices, (device) => [device.terminal_id, device.device_no])
  };
}

export function resolveRawPunchDevice(row: RawPunchRow, index: DeviceIndex) {
  if (row.device_id) {
    const device = index.byId.get(row.device_id);
    if (device) return { device, match: "device_id" as DeviceMatch };
  }
  const serial = index.bySerial.get(normalized(row.device_serial));
  if (serial) return { device: serial, match: "serial" as DeviceMatch };
  const terminal = index.byTerminal.get(normalized(row.terminal_id));
  if (terminal) return { device: terminal, match: "terminal" as DeviceMatch };
  const network = index.byNetwork.get(normalized(row.source_ip));
  if (network) return { device: network, match: "network" as DeviceMatch };
  return { device: undefined, match: null };
}

export function rawPunchDeviceMatchLabel(match: DeviceMatch | null) {
  if (match === "device_id") return "Linked device";
  if (match === "serial") return "Matched by serial";
  if (match === "terminal") return "Matched by terminal";
  if (match === "network") return "Matched by network";
  return "Location not identified";
}

export function rawPunchProfileType(punch: RawPunchResultRow | undefined) {
  if (!punch) return null;
  return punch.profile_type ?? (punch.employee_id ? "employee" : "field_executive");
}

export function rawPunchAccountId(punch: RawPunchResultRow | undefined) {
  return punch?.account_id ?? punch?.employee_id ?? punch?.field_executive_id ?? null;
}

export function rawPunchResultLabel(punch: RawPunchResultRow | undefined, alert: RawPunchAlertRow | undefined) {
  if (punch?.calculated) return "Recorded";
  if (punch && !punch.calculated) return "Inactive worker";
  if (alert?.alert_type === "unknown_enrolment") return "Unmapped ID";
  if (alert?.alert_type === "duplicate_enrolment_id") return "Duplicate ID";
  if (alert?.alert_type === "bad_timelog") return "Invalid punch";
  return alert ? "Rejected" : "Raw only";
}

export function safeRawPunchSearch(value: string | null | undefined) {
  return String(value ?? "").replace(/[,%()]/g, " ").trim();
}

export function safeRawPunchDate(value: string | null | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

export function normalizedEnrolmentId(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  return digits ? digits.replace(/^0+/, "") || "0" : text.toLowerCase();
}

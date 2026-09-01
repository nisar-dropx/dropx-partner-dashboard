import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { BiometricDeviceProfileFields } from "@/components/biometric-device-profile-fields";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SearchableSelect } from "@/components/searchable-select";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { bulkImportBiometricDevices, createBiometricDevice, deleteBiometricDevice, updateBiometricDevice } from "./actions";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  hide_from_location_list?: boolean | null;
};

type DeviceRow = {
  id: string;
  device_serial: string;
  terminal_id: string | null;
  device_no: string | null;
  location_id: string | null;
  device_name: string | null;
  model: string | null;
  local_ip_address: string | null;
  local_port: number | null;
  p2p_type: string | null;
  p2p_device_id: string | null;
  connection_mode: string | null;
  middleware_host: string | null;
  middleware_port: number | null;
  network_password: string | null;
  status: string | null;
  last_seen_at: string | null;
  last_source_ip: string | null;
  is_active: boolean;
  remarks: string | null;
};

type PunchLogRow = {
  device_id: string | null;
  enrolment_id: string;
  punch_time: string;
  punch_label: string | null;
  device_serial: string | null;
  location_id: string | null;
  calculated: boolean | null;
};

type EventLogRow = {
  device_id: string | null;
  device_serial: string | null;
  terminal_id: string | null;
  event_type: string | null;
  enrolment_id: string | null;
  trans_id: string | null;
  punch_time: string | null;
  received_at: string | null;
  created_at: string | null;
};

type WorkerInfo = {
  code: string;
  name: string;
};

function loadFlash() {
  const raw = cookies().get("dropx_biometric_devices_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

function formatDateTime(value: string | null) {
  return formatDashboardDateTime(value);
}

function isDeviceConnected(device: DeviceRow) {
  if (!device.is_active || !device.last_seen_at) return false;
  const lastSeen = new Date(device.last_seen_at).getTime();
  if (Number.isNaN(lastSeen)) return false;
  return Date.now() - lastSeen <= 10 * 60 * 1000;
}

function deviceConnectionText(device: DeviceRow) {
  return isDeviceConnected(device) ? "Connect" : "Disconnect";
}

function locationLabel(locationMap: Map<string, LocationRow>, locationId: string | null) {
  if (!locationId) return "-";
  const location = locationMap.get(locationId);
  if (!location) return "-";
  return location.station_name ? `${location.station_code}-${location.station_name}` : location.station_code;
}

function shortLocation(locationMap: Map<string, LocationRow>, locationId: string | null) {
  if (!locationId) return "-";
  return locationMap.get(locationId)?.station_code ?? "-";
}

async function loadWorkerMap(companyId: string, enrolmentIds: string[]) {
  const workerMap = new Map<string, WorkerInfo>();
  if (!supabaseAdmin || !enrolmentIds.length) return workerMap;
  const admin = supabaseAdmin;

  const enrolments = await admin
    .from("biometric_enrolments")
    .select("enrolment_id, employee_id, field_executive_id, profile_type, account_id")
    .eq("company_id", companyId)
    .in("enrolment_id", enrolmentIds);
  if (enrolments.error) return workerMap;

  const employeeIds = Array.from(new Set((enrolments.data ?? []).map((row) => row.employee_id).filter(Boolean))) as string[];
  const executiveIds = Array.from(new Set((enrolments.data ?? []).map((row) => row.field_executive_id).filter(Boolean))) as string[];
  const profileIds = new Map<string, string[]>();
  for (const row of enrolments.data ?? []) {
    if (!row.profile_type || row.profile_type === "employee" || row.profile_type === "field_executive" || !row.account_id) continue;
    profileIds.set(row.profile_type, [...(profileIds.get(row.profile_type) ?? []), row.account_id]);
  }
  const employees = employeeIds.length
    ? await admin.from("employees").select("id, employee_code, full_name").eq("company_id", companyId).in("id", employeeIds)
    : { data: [], error: null };
  const executives = executiveIds.length
    ? await admin.from("field_executives").select("id, dropx_id, full_name").eq("company_id", companyId).in("id", executiveIds)
    : { data: [], error: null };
  const profileTables = { contractor: "contractors", vendor: "vendors", worker: "workers" } as const;
  const profileResults = await Promise.all(Object.entries(profileTables).map(async ([profileType, table]) => {
    const ids = Array.from(new Set(profileIds.get(profileType) ?? []));
    const result = ids.length
      ? await admin.from(table).select("id, dropx_id, full_name").eq("company_id", companyId).in("id", ids)
      : { data: [], error: null };
    return [profileType, new Map((result.data ?? []).map((profile) => [profile.id, {
      code: profile.dropx_id ?? "-",
      name: profile.full_name ?? "Unknown"
    }]))] as const;
  }));
  const profilesByType = new Map(profileResults);

  const employeesById = new Map((employees.data ?? []).map((employee) => [employee.id, {
    code: employee.employee_code ?? "-",
    name: employee.full_name ?? "Unknown"
  }]));
  const executivesById = new Map((executives.data ?? []).map((executive) => [executive.id, {
    code: executive.dropx_id ?? "-",
    name: executive.full_name ?? "Unknown"
  }]));

  for (const enrolment of enrolments.data ?? []) {
    const worker = enrolment.employee_id
      ? employeesById.get(enrolment.employee_id)
      : enrolment.field_executive_id
        ? executivesById.get(enrolment.field_executive_id)
        : enrolment.profile_type && enrolment.account_id
          ? profilesByType.get(enrolment.profile_type)?.get(enrolment.account_id)
          : null;
    workerMap.set(enrolment.enrolment_id, worker ?? { code: enrolment.enrolment_id, name: "Unknown enrolment" });
  }

  return workerMap;
}

async function loadDeviceData(companyId: string, locationScopeIds: string[], hasAllLocationAccess: boolean) {
  if (!supabaseAdmin) {
    return {
      devices: [] as DeviceRow[],
      events: [] as EventLogRow[],
      locations: [] as LocationRow[],
      locationMap: new Map<string, LocationRow>(),
      punches: [] as PunchLogRow[],
      workerMap: new Map<string, WorkerInfo>(),
      error: "Supabase service role key is not configured."
    };
  }

  const [devicesResult, locationsResult] = await Promise.all([
    supabaseAdmin
      .from("biometric_devices")
      .select(`
        id,
        device_serial,
        terminal_id,
        device_no,
        location_id,
        device_name,
        model,
        local_ip_address,
        local_port,
        p2p_type,
        p2p_device_id,
        connection_mode,
        middleware_host,
        middleware_port,
        network_password,
        status,
        last_seen_at,
        last_source_ip,
        is_active,
        remarks
      `)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, hide_from_location_list")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code")
  ]);

  if (devicesResult.error) return { devices: [], events: [], locations: [], locationMap: new Map(), punches: [], workerMap: new Map(), error: devicesResult.error.message };
  if (locationsResult.error) return { devices: [], events: [], locations: [], locationMap: new Map(), punches: [], workerMap: new Map(), error: locationsResult.error.message };

  const allLocations = (locationsResult.data ?? []) as LocationRow[];
  const locations = hasAllLocationAccess
    ? allLocations
    : allLocations.filter((location) => locationScopeIds.includes(location.id) && !location.hide_from_location_list);
  const allowedLocationIds = new Set(locations.map((location) => location.id));
  const devices = (hasAllLocationAccess
    ? (devicesResult.data ?? [])
    : (devicesResult.data ?? []).filter((device) => !device.location_id || allowedLocationIds.has(device.location_id))) as DeviceRow[];
  const locationMap = new Map(locations.map((location) => [location.id, location]));

  const [punchResult, eventResult] = await Promise.all([
    supabaseAdmin
      .from("attendance_punches")
      .select("device_id, enrolment_id, punch_time, punch_label, device_serial, location_id, calculated")
      .eq("company_id", companyId)
      .order("punch_time", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("biometric_raw_events")
      .select("device_id, device_serial, terminal_id, event_type, enrolment_id, trans_id, punch_time, received_at, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(5)
  ]);

  const punches = punchResult.error ? [] : (punchResult.data ?? []) as PunchLogRow[];
  const workerMap = await loadWorkerMap(companyId, Array.from(new Set(punches.map((punch) => punch.enrolment_id).filter(Boolean))));

  return {
    devices,
    events: eventResult.error ? [] : (eventResult.data ?? []) as EventLogRow[],
    locations,
    locationMap,
    punches,
    workerMap,
    error: null
  };
}

function DeviceForm({
  action,
  device,
  locations,
  submitLabel
}: {
  action: (formData: FormData) => Promise<void>;
  device?: DeviceRow | null;
  locations: LocationRow[];
  submitLabel: string;
}) {
  const locationOptions = locations.map((location) => ({
    value: location.id,
    label: location.station_code,
    helper: location.station_name ?? undefined
  }));
  return (
    <form action={action} className="form-grid three">
      {device ? <input name="id" type="hidden" value={device.id} /> : null}

      <fieldset className="span-3 report-choice-panel compact-choice-panel">
        <legend>Connection type</legend>
        <div className="report-radio-grid two">
          <label className="radio-card">
            <input name="connection_mode" type="radio" value="TCP_PUSH" defaultChecked={(device?.connection_mode ?? "TCP_PUSH") !== "P2P"} />
            <span>Normal</span>
          </label>
          <label className="radio-card">
            <input name="connection_mode" type="radio" value="P2P" defaultChecked={device?.connection_mode === "P2P"} />
            <span>P2P</span>
          </label>
        </div>
      </fieldset>

      <label>Device ID<input className="field" inputMode="numeric" name="terminal_id" pattern="[0-9]{1,10}" placeholder="1" required defaultValue={device?.terminal_id ?? device?.device_no ?? ""} /></label>
      <label>Location
        <SearchableSelect name="location_id" options={locationOptions} defaultValue={device?.location_id ?? undefined} placeholder="Select location" required />
      </label>
      <label>Serial no.<input className="field" name="device_serial" placeholder="A240901534" required defaultValue={device?.device_serial ?? ""} /></label>

      <BiometricDeviceProfileFields defaultModel={device?.model} />
      <label>Local IP address<input className="field" name="local_ip_address" placeholder="192.168.001.224" required defaultValue={device?.local_ip_address ?? ""} /></label>
      <label>Local port no.<input className="field" inputMode="numeric" name="local_port" placeholder="5005" required defaultValue={device?.local_port ?? ""} /></label>

      <label>Network password<input className="field" name="network_password" placeholder="0 or blank" defaultValue={device?.network_password ?? ""} /></label>
      <label>P2P type<input className="field" name="p2p_type" placeholder="Optional" defaultValue={device?.p2p_type ?? ""} /></label>
      <label>P2P device ID<input className="field" name="p2p_device_id" placeholder="Optional" defaultValue={device?.p2p_device_id ?? ""} /></label>


      <div className="span-3 helper-card">
        <strong>Live status is automatic.</strong> Device Master stores the terminal identity and network details. Connected/disconnected status is calculated from real middleware events and punches received from the device.
      </div>

      <div className="form-actions span-3 align-right">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function DeviceStatusPanel({
  devices,
  locationMap,
  title,
  tone
}: {
  devices: DeviceRow[];
  locationMap: Map<string, LocationRow>;
  title: string;
  tone: "connected" | "disconnected";
}) {
  const rowStyle = tone === "connected"
    ? { background: "#22c55e", color: "#fff" }
    : { background: "#ef4444", color: "#fff" };
  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>{title}</h2>
          <p className="subtle">{devices.length} devices</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Device no.</th>
              <th>Location</th>
              <th>Serial no.</th>
              <th>Model</th>
              <th>Status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {devices.length ? devices.slice(0, 5).map((device) => (
              <tr key={device.id} style={rowStyle}>
                <td><strong>{device.device_no || device.terminal_id || "-"}</strong></td>
                <td>{locationLabel(locationMap, device.location_id)}</td>
                <td>{device.device_serial}</td>
                <td>{device.model || "-"}</td>
                <td>{deviceConnectionText(device)}</td>
                <td>{formatDateTime(device.last_seen_at)}</td>
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={6}>No devices found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const dynamic = "force-dynamic";

export default async function DeviceMasterPage({
  searchParams
}: {
  searchParams?: { add?: string; edit?: string; q?: string };
}) {
  const authorization = await requirePagePermission("biometric_devices", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.biometric_devices;
  const { devices, events, locations, locationMap, punches, workerMap, error } = await loadDeviceData(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const flash = loadFlash();
  const query = String(searchParams?.q ?? "").trim().toLowerCase();
  const filteredDevices = devices.filter((device) => [
    device.device_no,
    device.device_name,
    device.device_serial,
    device.terminal_id,
    device.local_ip_address,
    device.last_source_ip,
    device.model,
    shortLocation(locationMap, device.location_id),
    locationLabel(locationMap, device.location_id)
  ].join(" ").toLowerCase().includes(query));
  const connectedDevices = devices.filter(isDeviceConnected);
  const disconnectedDevices = devices.filter((device) => !isDeviceConnected(device));
  const editDevice = devices.find((device) => device.id === searchParams?.edit) ?? null;

  return (
    <AppShell active="Device Master" pageCode="biometric_devices">
      <PageHead
        eyebrow="Master Data"
        title="Device Master"
        subtitle="Add, edit, remove, and monitor attendance devices by location."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/biometric_attendance_upgrade_existing_tables.sql` in Supabase SQL Editor, then refresh this page.
            </p>
          </div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <>
          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Device Master</h2>
                <p className="subtle">{filteredDevices.length} of {devices.length} devices</p>
              </div>
              <div className="master-toolbar">
                <form className="inline-search" action="/master/biometric-devices">
                  <input className="field" defaultValue={searchParams?.q ?? ""} name="q" placeholder="Search device, serial, location" />
                  <button className="button secondary compact" type="submit">Search</button>
                  {query ? <PendingLink className="button secondary compact" href="/master/biometric-devices">Clear</PendingLink> : null}
                </form>
                {pagePermission.canAdd ? <PendingLink className="button compact" href="/master/biometric-devices?add=1" scroll={false}>Add device</PendingLink> : null}
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Device no.</th>
                    <th>Location</th>
                    <th>Local IP address</th>
                    <th>Local port no.</th>
                    <th>Model</th>
                    <th>Connector</th>
                    <th>Serial no.</th>
                    <th>Last source IP</th>
                    <th>Connect info</th>
                    <th>Live status</th>
                    {pagePermission.canEdit ? <th>Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.length ? filteredDevices.map((device) => (
                    <tr key={device.id}>
                      <td><strong>{device.device_no || device.terminal_id || "-"}</strong></td>
                      <td>{shortLocation(locationMap, device.location_id)}</td>
                      <td>{device.local_ip_address || "-"}</td>
                      <td>{device.local_port ?? "-"}</td>
                      <td>{device.model || "-"}</td>
                      <td>{device.middleware_host || "bio.dropxlogistics.com"}:{device.middleware_port ?? 6010}</td>
                      <td><strong>{device.device_serial}</strong></td>
                      <td>{device.last_source_ip || "-"}</td>
                      <td>{formatDateTime(device.last_seen_at)}</td>
                      <td><StatusPill status={isDeviceConnected(device) ? "Connected" : "Disconnected"} /></td>
                      {pagePermission.canEdit ? (
                        <td>
                          <div className="row-actions">
                            <PendingLink className="button secondary compact" href={`/master/biometric-devices?edit=${device.id}`} scroll={false}>Edit</PendingLink>
                            <form action={deleteBiometricDevice}>
                              <input name="id" type="hidden" value={device.id} />
                              <SubmitButton
                                className="button warning compact"
                                confirmMessage="Delete this device?"
                                confirmSubmitText="Delete"
                                pendingText="Deleting"
                              >
                                Delete
                              </SubmitButton>
                            </form>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )) : (
                    <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 11 : 10}>No devices found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {pagePermission.canAdd ? (
            <section className="panel workforce-bulk-panel">
              <div className="panel-head">
                <div>
                  <h2>Bulk upload devices</h2>
                  <p className="subtle">Temporary migration tool for uploading your current biometric devices. Imported devices are regular Device Master records.</p>
                </div>
                <a className="button secondary compact" download href="/templates/biometric-devices-template.csv">Download CSV template</a>
              </div>
              <form action={bulkImportBiometricDevices} className="workforce-bulk-form">
                <div className="workforce-template-note">
                  <strong>Required columns</strong>
                  <span>Device ID, Location, Serial no., Model no., Local IP address, Local port no. Optional: Connection type, network/P2P details and remarks.</span>
                </div>
                <input accept=".xlsx,.xls,.csv" className="field" name="bulk_file" required type="file" />
                <SubmitButton
                  confirmDescription="This migration tool imports current devices as regular Device Master records. Existing duplicate serial numbers or device IDs will be skipped."
                  confirmMessage="Import devices from this file?"
                  confirmSubmitText="Import"
                  confirmTitle="Confirm device upload"
                >
                  Upload devices
                </SubmitButton>
              </form>
            </section>
          ) : null}

          <section className="split-grid">
            <DeviceStatusPanel devices={connectedDevices} locationMap={locationMap} title="Connected Device List" tone="connected" />
            <DeviceStatusPanel devices={disconnectedDevices} locationMap={locationMap} title="Disconnected Device List" tone="disconnected" />
          </section>

          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Notifications Panel</h2>
                <p className="subtle">Last 5 punch records received from devices</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Assigned location</th>
                    <th>Punch device location</th>
                    <th>Name</th>
                    <th>Empcode</th>
                    <th>Punch date</th>
                    <th>Device</th>
                  </tr>
                </thead>
                <tbody>
                  {punches.length ? punches.map((punch) => {
                    const worker = workerMap.get(punch.enrolment_id);
                    const punchDevice = devices.find((device) => device.id === punch.device_id || device.device_serial === punch.device_serial);
                    return (
                      <tr key={`${punch.enrolment_id}-${punch.punch_time}-${punch.punch_label}`}>
                        <td>{shortLocation(locationMap, punch.location_id)}</td>
                        <td>{shortLocation(locationMap, punchDevice?.location_id ?? null)}</td>
                        <td>{worker?.name ?? "Unknown enrolment"}</td>
                        <td>{worker?.code ?? punch.enrolment_id}</td>
                        <td>{formatDateTime(punch.punch_time)}</td>
                        <td>{punch.device_serial ?? "-"}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="empty-cell" colSpan={6}>No punch logs received yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head toolbar">
              <div>
                <h2>Device Event Panel</h2>
                <p className="subtle">Last 5 raw events received by the middleware/API</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Device SRNO.</th>
                    <th>Terminal ID</th>
                    <th>Event date time</th>
                    <th>User ID</th>
                    <th>Event name</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length ? events.map((event) => {
                    const eventDevice = devices.find((device) => device.id === event.device_id || device.device_serial === event.device_serial);
                    return (
                      <tr key={`${event.device_serial}-${event.trans_id}-${event.created_at}`}>
                        <td>{shortLocation(locationMap, eventDevice?.location_id ?? null)}</td>
                        <td>{event.device_serial ?? "-"}</td>
                        <td>{event.terminal_id ?? "-"}</td>
                        <td>{formatDateTime(event.punch_time ?? event.received_at ?? event.created_at)}</td>
                        <td>{event.enrolment_id ?? "-"}</td>
                        <td>{event.event_type || "Punch"}</td>
                        <td>{event.trans_id ?? "-"}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="empty-cell" colSpan={7}>No device events received yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {!error && searchParams?.add === "1" && pagePermission.canAdd ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Add device</h2>
                <p className="subtle">Add the physical terminal details exactly as shown on the device.</p>
              </div>
              <PendingLink className="icon-button" href="/master/biometric-devices" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DeviceForm action={createBiometricDevice} locations={locations} submitLabel="Add device" />
          </section>
        </div>
      ) : null}

      {!error && editDevice && pagePermission.canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide">
            <div className="panel-head">
              <div>
                <h2>Edit device</h2>
                <p className="subtle">Update the physical terminal identity and network details.</p>
              </div>
              <PendingLink className="icon-button" href="/master/biometric-devices" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <DeviceForm action={updateBiometricDevice} device={editDevice} locations={locations} submitLabel="Save changes" />
            <form action={deleteBiometricDevice} className="danger-form">
              <input name="id" type="hidden" value={editDevice.id} />
              <SubmitButton
                className="button warning"
                confirmMessage="Delete this device?"
                confirmSubmitText="Delete"
                pendingText="Deleting"
              >
                Delete device
              </SubmitButton>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}

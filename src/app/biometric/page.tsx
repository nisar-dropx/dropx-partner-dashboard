import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type DeviceRow = {
  id: string;
  device_no: string | null;
  device_serial: string;
  last_seen_at: string | null;
  last_source_ip: string | null;
  location_id: string | null;
  model: string | null;
  status: string | null;
  terminal_id: string | null;
};

type LocationRow = {
  id: string;
  station_code: string | null;
  station_name: string | null;
};

type RawEventRow = {
  created_at: string | null;
  device_serial: string | null;
  enrolment_id: string | null;
  event_type: string | null;
  punch_time: string | null;
  source_ip: string | null;
  terminal_id: string | null;
  trans_id: string | null;
};

type PunchRow = {
  calculated: boolean | null;
  device_serial: string | null;
  enrolment_id: string;
  punch_label: string | null;
  punch_time: string;
  worker_status: string | null;
};

type AlertRow = {
  alert_type: string | null;
  created_at: string | null;
  enrolment_id: string | null;
  message: string | null;
  severity: string | null;
};

type SettingsRow = {
  host_pc_address: string | null;
  host_pc_port: number | null;
  is_enabled: boolean | null;
  webhook_url: string | null;
};

type DuplicateRow = {
  enrolmentId: string;
  workers: string[];
};

function formatDateTime(value: string | null) {
  return formatDashboardDateTime(value);
}

function formatTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata"
  }).format(date);
}

function isConnected(device: DeviceRow) {
  if (!device.last_seen_at) return false;
  const lastSeen = new Date(device.last_seen_at).getTime();
  return Number.isFinite(lastSeen) && Date.now() - lastSeen <= 10 * 60 * 1000;
}

function deviceReportingStatus(device: DeviceRow) {
  if (!isConnected(device)) return "Disconnected";
  if (device.status?.toLowerCase() === "heartbeat only") return "Heartbeat only";
  return "Reporting";
}

function cleanEnrolment(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.replace(/^0+/, "") || "0" : "";
}

function locationLabel(locations: Map<string, LocationRow>, id: string | null) {
  if (!id) return "-";
  const location = locations.get(id);
  if (!location) return "-";
  return location.station_name ? `${location.station_code}-${location.station_name}` : location.station_code ?? "-";
}

async function loadDuplicateEnrolments(companyId: string) {
  if (!supabaseAdmin) return [] as DuplicateRow[];
  const admin = supabaseAdmin;
  const profileTables = [
    ["Field executive", "field_executives"],
    ["Independent contractor", "contractors"],
    ["Vendor", "vendors"],
    ["Worker", "workers"]
  ] as const;
  const [employees, ...profiles] = await Promise.all([
    admin
      .from("employees")
      .select("employee_code, full_name, biometric_id")
      .eq("company_id", companyId)
      .not("biometric_id", "is", null),
    ...profileTables.map(([, table]) => admin
      .from(table)
      .select("dropx_id, full_name, biometric_id")
      .eq("company_id", companyId)
      .not("biometric_id", "is", null))
  ]);

  const grouped = new Map<string, string[]>();
  for (const employee of employees.data ?? []) {
    const enrolmentId = cleanEnrolment(employee.biometric_id);
    if (!enrolmentId) continue;
    grouped.set(enrolmentId, [...(grouped.get(enrolmentId) ?? []), `${employee.employee_code ?? enrolmentId} - ${employee.full_name ?? "Employee"}`]);
  }
  for (const [index, result] of profiles.entries()) {
    const [label] = profileTables[index];
    for (const profile of result.data ?? []) {
      const enrolmentId = cleanEnrolment(profile.biometric_id);
      if (!enrolmentId) continue;
      grouped.set(enrolmentId, [...(grouped.get(enrolmentId) ?? []), `${profile.dropx_id ?? enrolmentId} - ${profile.full_name ?? label}`]);
    }
  }

  return Array.from(grouped.entries())
    .filter(([, workers]) => workers.length > 1)
    .map(([enrolmentId, workers]) => ({ enrolmentId, workers }));
}

async function loadBiometricMonitor(companyId: string) {
  if (!supabaseAdmin) {
    return {
      alerts: [] as AlertRow[],
      devices: [] as DeviceRow[],
      duplicates: [] as DuplicateRow[],
      error: "Supabase service role key is not configured.",
      events: [] as RawEventRow[],
      locations: new Map<string, LocationRow>(),
      punches: [] as PunchRow[],
      settings: null as SettingsRow | null
    };
  }

  const [settings, devices, locations, events, punches, alerts, duplicates] = await Promise.all([
    supabaseAdmin
      .from("biometric_middleware_settings")
      .select("is_enabled, host_pc_address, host_pc_port, webhook_url")
      .eq("company_id", companyId)
      .eq("id", true)
      .maybeSingle(),
    supabaseAdmin
      .from("biometric_devices")
      .select("id, device_no, terminal_id, device_serial, location_id, model, status, last_seen_at, last_source_ip")
      .eq("company_id", companyId)
      .order("last_seen_at", { ascending: false, nullsFirst: false }),
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name")
      .eq("company_id", companyId),
    supabaseAdmin
      .from("biometric_raw_events")
      .select("created_at, event_type, device_serial, terminal_id, trans_id, enrolment_id, punch_time, source_ip")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabaseAdmin
      .from("attendance_punches")
      .select("enrolment_id, device_serial, punch_time, punch_label, calculated, worker_status")
      .eq("company_id", companyId)
      .order("punch_time", { ascending: false })
      .limit(10),
    supabaseAdmin
      .from("biometric_alerts")
      .select("created_at, alert_type, severity, enrolment_id, message")
      .eq("company_id", companyId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
    loadDuplicateEnrolments(companyId)
  ]);

  const firstError = [settings.error, devices.error, locations.error, events.error, punches.error, alerts.error]
    .find(Boolean);

  return {
    alerts: (alerts.data ?? []) as AlertRow[],
    devices: (devices.data ?? []) as DeviceRow[],
    duplicates,
    error: firstError?.message ?? null,
    events: (events.data ?? []) as RawEventRow[],
    locations: new Map(((locations.data ?? []) as LocationRow[]).map((location) => [location.id, location])),
    punches: (punches.data ?? []) as PunchRow[],
    settings: settings.data as SettingsRow | null
  };
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default async function BiometricMonitorPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const data = await loadBiometricMonitor(companyId);
  const reportingCount = data.devices.filter((device) => deviceReportingStatus(device) === "Reporting").length;
  const calculatedPunches = data.punches.filter((punch) => punch.calculated !== false).length;

  return (
    <AppShell active="Biometric Monitor" pageCode="app_settings">
      <PageHead
        eyebrow="Settings"
        title="Biometric Monitor"
        subtitle="Trace the real flow from device event to calculated attendance."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {data.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error}</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>Middleware endpoint</h2>
            <p className="subtle">Use this for verifying the physical device setup and the API push target.</p>
          </div>
          <div className="row-actions">
            <PendingLink className="button secondary compact" href="/settings/biometric">Config</PendingLink>
            <PendingLink className="button secondary compact" href="/master/biometric-devices">Device Master</PendingLink>
          </div>
        </div>
        <div className="device-config-card">
          <dl>
            <div><dt>Status</dt><dd>{data.settings?.is_enabled ? "Enabled" : "Disabled"}</dd></div>
            <div><dt>Device host</dt><dd>{data.settings?.host_pc_address ?? "bio.dropxlogistics.com"}</dd></div>
            <div><dt>Device port</dt><dd>{data.settings?.host_pc_port ?? 6010}</dd></div>
            <div><dt>Dashboard API</dt><dd>{data.settings?.webhook_url ?? "https://dashboard.dropxlogistics.com/api/biometric/punch"}</dd></div>
          </dl>
        </div>
      </section>

      <section className="summary-grid">
        <StatCard label="Mapped devices" value={data.devices.length} />
        <StatCard label="Reporting attendance" value={reportingCount} />
        <StatCard label="Recent raw events" value={data.events.length} />
        <StatCard label="Calculated punches" value={calculatedPunches} />
      </section>

      {data.duplicates.length ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Duplicate biometric enrolment IDs found</strong>
            <p className="subtle" style={{ marginTop: 6 }}>These IDs will not be auto-linked until only one active worker has that enrolment ID.</p>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>Enrolment ID</th><th>Workers using this ID</th></tr></thead>
                <tbody>
                  {data.duplicates.map((duplicate) => (
                    <tr key={duplicate.enrolmentId}>
                      <td><strong>{duplicate.enrolmentId}</strong></td>
                      <td>{duplicate.workers.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Device status</h2>
            <p className="subtle">Reporting means attendance data is flowing. Heartbeat only means the server can see the device, but no punch has been received.</p>
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
                <th>Source IP</th>
              </tr>
            </thead>
            <tbody>
              {data.devices.length ? data.devices.map((device) => (
                <tr key={device.id}>
                  <td>{device.device_no ?? device.terminal_id ?? "-"}</td>
                  <td>{locationLabel(data.locations, device.location_id)}</td>
                  <td><strong>{device.device_serial}</strong></td>
                  <td>{device.model ?? "-"}</td>
                  <td><StatusPill status={deviceReportingStatus(device)} /></td>
                  <td>{formatDateTime(device.last_seen_at)}</td>
                  <td>{device.last_source_ip ?? "-"}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={7}>No devices are mapped yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="split-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Raw middleware events</h2>
              <p className="subtle">If a punch reaches the middleware/API, it appears here first.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Received</th><th>Event</th><th>Device</th><th>Enrolment</th><th>Punch time</th><th>Trans ID</th></tr></thead>
              <tbody>
                {data.events.length ? data.events.map((event, index) => (
                  <tr key={`${event.trans_id ?? index}-${event.created_at ?? ""}`}>
                    <td>{formatDateTime(event.created_at)}</td>
                    <td>{event.event_type ?? "-"}</td>
                    <td>{event.device_serial ?? "-"}</td>
                    <td>{event.enrolment_id ?? "-"}</td>
                    <td>{formatDateTime(event.punch_time)}</td>
                    <td>{event.trans_id ?? "-"}</td>
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={6}>No raw events received yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Calculated punches</h2>
              <p className="subtle">These are the punches that are eligible for attendance reports.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Device</th><th>Enrolment</th><th>Label</th><th>Worker status</th><th>Calculated</th></tr></thead>
              <tbody>
                {data.punches.length ? data.punches.map((punch, index) => (
                  <tr key={`${punch.enrolment_id}-${punch.punch_time}-${index}`}>
                    <td>{formatDateTime(punch.punch_time)}</td>
                    <td>{punch.device_serial ?? "-"}</td>
                    <td>{punch.enrolment_id}</td>
                    <td>{punch.punch_label ?? "-"}</td>
                    <td>{punch.worker_status ?? "-"}</td>
                    <td>{punch.calculated === false ? "No" : "Yes"}</td>
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={6}>No calculated punches yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Open biometric alerts</h2>
            <p className="subtle">Unknown enrolments, inactive workers, bad punches, and duplicate mappings appear here.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Enrolment</th><th>Message</th></tr></thead>
            <tbody>
              {data.alerts.length ? data.alerts.map((alert, index) => (
                <tr key={`${alert.alert_type ?? index}-${alert.created_at ?? ""}`}>
                  <td>{formatDateTime(alert.created_at)}</td>
                  <td>{alert.severity ?? "-"}</td>
                  <td>{alert.alert_type ?? "-"}</td>
                  <td>{alert.enrolment_id ?? "-"}</td>
                  <td>{alert.message ?? "-"}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={5}>No open biometric alerts.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

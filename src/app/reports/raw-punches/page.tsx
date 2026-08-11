import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type Params = {
  device?: string;
  from?: string;
  page?: string;
  per_page?: string;
  search?: string;
  to?: string;
};

type RawPunchRow = {
  created_at: string;
  device_id: string | null;
  device_serial: string;
  enrolment_id: string | null;
  event_type: string | null;
  id: string;
  punch_time: string | null;
  received_at: string | null;
  source_ip: string | null;
  terminal_id: string | null;
  trans_id: string | null;
};

type DeviceRow = {
  device_no: string | null;
  device_serial: string;
  id: string;
  location_id: string | null;
  model: string | null;
};

type PunchResultRow = {
  account_id: string | null;
  calculated: boolean;
  employee_id: string | null;
  field_executive_id: string | null;
  profile_type: string | null;
  raw_event_id: string | null;
  worker_status: string | null;
};

type AlertRow = {
  alert_type: string;
  message: string | null;
  raw_event_id: string | null;
};

type WorkerRow = { id: string; code: string | null; full_name: string | null };

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeSearch(value: string | undefined) {
  return String(value ?? "").replace(/[,%()]/g, " ").trim();
}

function pageHref(params: Params, page: number) {
  const next = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && key !== "page") next.set(key, value);
  });
  next.set("page", String(page));
  return `/reports/raw-punches?${next}`;
}

function resultLabel(punch: PunchResultRow | undefined, alert: AlertRow | undefined) {
  if (punch?.calculated) return "Recorded";
  if (punch && !punch.calculated) return "Inactive worker";
  if (alert?.alert_type === "unknown_enrolment") return "Unmapped ID";
  if (alert?.alert_type === "duplicate_enrolment_id") return "Duplicate ID";
  if (alert?.alert_type === "bad_timelog") return "Invalid punch";
  return alert ? "Rejected" : "Raw only";
}

export default async function RawPunchesPage({ searchParams = {} }: { searchParams?: Params }) {
  const authorization = await requirePagePermission("raw_punch_reports", "access");
  const companyId = requireCompanyId(authorization);
  const page = positiveInteger(searchParams.page, 1);
  const requestedPageSize = positiveInteger(searchParams.per_page, 20);
  const pageSize = [20, 100, 500, 1000].includes(requestedPageSize) ? requestedPageSize : 20;
  const search = safeSearch(searchParams.search);
  let rows: RawPunchRow[] = [];
  let devices: DeviceRow[] = [];
  let total = 0;
  let error: string | null = null;
  const punchByRawEvent = new Map<string, PunchResultRow>();
  const alertByRawEvent = new Map<string, AlertRow>();
  const workerByKey = new Map<string, WorkerRow>();
  const locationById = new Map<string, string>();

  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    const [deviceResult, locationResult] = await Promise.all([
      supabaseAdmin
        .from("biometric_devices")
        .select("id, device_no, device_serial, model, location_id")
        .eq("company_id", companyId)
        .order("device_no"),
      supabaseAdmin
        .from("stations")
        .select("id, station_code, station_name")
        .eq("company_id", companyId)
    ]);

    if (deviceResult.error || locationResult.error) {
      error = deviceResult.error?.message ?? locationResult.error?.message ?? "Unable to load report filters.";
    } else {
      const allowedLocationIds = new Set(authorization.locationScopeIds);
      devices = ((deviceResult.data ?? []) as DeviceRow[]).filter((device) =>
        authorization.hasAllLocationAccess || Boolean(device.location_id && allowedLocationIds.has(device.location_id))
      );
      (locationResult.data ?? []).forEach((location) => {
        locationById.set(location.id, [location.station_code, location.station_name].filter(Boolean).join(" - "));
      });

      const allowedDeviceIds = devices.map((device) => device.id);
      const selectedDevice = devices.some((device) => device.id === searchParams.device) ? searchParams.device : "";
      if (authorization.hasAllLocationAccess || allowedDeviceIds.length) {
        let query = supabaseAdmin
          .from("biometric_raw_events")
          .select("id, device_id, device_serial, terminal_id, trans_id, enrolment_id, punch_time, received_at, event_type, source_ip, created_at", { count: "exact" })
          .eq("company_id", companyId)
          .ilike("event_type", "timelog")
          .order("punch_time", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false });

        if (!authorization.hasAllLocationAccess) query = query.in("device_id", allowedDeviceIds);
        if (selectedDevice) query = query.eq("device_id", selectedDevice);
        if (searchParams.from) query = query.gte("punch_time", `${searchParams.from}T00:00:00+05:30`);
        if (searchParams.to) query = query.lte("punch_time", `${searchParams.to}T23:59:59.999+05:30`);
        if (search) {
          query = query.or(`enrolment_id.ilike.%${search}%,device_serial.ilike.%${search}%,terminal_id.ilike.%${search}%,trans_id.ilike.%${search}%`);
        }

        const result = await query.range((page - 1) * pageSize, page * pageSize - 1);
        if (result.error) {
          error = result.error.message;
        } else {
          rows = (result.data ?? []) as RawPunchRow[];
          total = result.count ?? rows.length;
        }
      }
    }

    if (!error && rows.length) {
      const rawEventIds = rows.map((row) => row.id);
      const [punchResult, alertResult] = await Promise.all([
        supabaseAdmin
          .from("attendance_punches")
          .select("raw_event_id, profile_type, account_id, employee_id, field_executive_id, worker_status, calculated")
          .eq("company_id", companyId)
          .in("raw_event_id", rawEventIds),
        supabaseAdmin
          .from("biometric_alerts")
          .select("raw_event_id, alert_type, message")
          .eq("company_id", companyId)
          .in("raw_event_id", rawEventIds)
          .order("created_at", { ascending: false })
      ]);

      if (punchResult.error || alertResult.error) {
        error = punchResult.error?.message ?? alertResult.error?.message ?? "Unable to load punch processing results.";
      } else {
        ((punchResult.data ?? []) as PunchResultRow[]).forEach((item) => {
          if (item.raw_event_id) punchByRawEvent.set(item.raw_event_id, item);
        });
        ((alertResult.data ?? []) as AlertRow[]).forEach((item) => {
          if (item.raw_event_id && !alertByRawEvent.has(item.raw_event_id)) alertByRawEvent.set(item.raw_event_id, item);
        });

        const idsByProfile = new Map<string, Set<string>>();
        punchByRawEvent.forEach((item) => {
          const profileType = item.profile_type ?? (item.employee_id ? "employee" : "field_executive");
          const id = item.account_id ?? item.employee_id ?? item.field_executive_id;
          if (!id) return;
          if (!idsByProfile.has(profileType)) idsByProfile.set(profileType, new Set());
          idsByProfile.get(profileType)!.add(id);
        });

        const tableByProfile: Record<string, { table: string; code: string }> = {
          employee: { table: "employees", code: "employee_code" },
          field_executive: { table: "field_executives", code: "dropx_id" },
          contractor: { table: "contractors", code: "dropx_id" },
          vendor: { table: "vendors", code: "dropx_id" },
          worker: { table: "workers", code: "dropx_id" }
        };
        await Promise.all(Array.from(idsByProfile, async ([profileType, idSet]) => {
          const config = tableByProfile[profileType];
          if (!config || !idSet.size) return;
          const result = await supabaseAdmin!
            .from(config.table)
            .select(`id, full_name, ${config.code}`)
            .eq("company_id", companyId)
            .in("id", Array.from(idSet));
          if (result.error) throw new Error(result.error.message);
          const workers = (result.data ?? []) as unknown as Array<Record<string, string | null>>;
          workers.forEach((worker) => {
            workerByKey.set(`${profileType}:${worker.id}`, {
              id: String(worker.id),
              code: String(worker[config.code] ?? "") || null,
              full_name: worker.full_name ?? null
            });
          });
        })).catch((workerError) => {
          error = workerError instanceof Error ? workerError.message : "Unable to load worker names.";
        });
      }
    }
  }

  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppShell active="Raw Punches" pageCode="raw_punch_reports">
      <PageHead
        eyebrow="Reports"
        title="Raw Punches"
        subtitle="Every biometric TimeLog received from devices, including unmapped, inactive, duplicate, and rejected enrolment IDs."
      />
      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load raw punches</strong><p className="subtle">{error}</p></div></section> : null}
      <section className="panel">
        <form className="event-log-filters">
          <label>From<input className="field" defaultValue={searchParams.from} name="from" type="date" /></label>
          <label>To<input className="field" defaultValue={searchParams.to} name="to" type="date" /></label>
          <label>Device<select className="field" defaultValue={searchParams.device} name="device"><option value="">All devices</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.device_no || device.device_serial} · {device.device_serial}</option>)}</select></label>
          <label className="event-log-search">Search<input className="field" defaultValue={searchParams.search} name="search" placeholder="Enrolment, device, terminal, transaction" /></label>
          <label>Rows<select className="field" defaultValue={String(pageSize)} name="per_page"><option>20</option><option>100</option><option>500</option><option>1000</option></select></label>
          <div className="event-log-filter-actions"><button className="button" type="submit">Apply</button><Link className="button secondary" href="/reports/raw-punches">Clear</Link></div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Complete device punch history</h2><p className="subtle">{total ? `Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total} raw punches.` : "No matching raw punches."} Newest punches are shown first.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Punch time</th><th>Location</th><th>Device</th><th>Enrolment ID</th><th>Employee / IC</th><th>Transaction</th><th>Capture result</th><th>Reason</th></tr></thead><tbody>
          {rows.map((row) => {
            const device = row.device_id ? deviceById.get(row.device_id) : undefined;
            const punch = punchByRawEvent.get(row.id);
            const alert = alertByRawEvent.get(row.id);
            const profileType = punch
              ? punch.profile_type ?? (punch.employee_id ? "employee" : "field_executive")
              : null;
            const accountId = punch?.account_id ?? punch?.employee_id ?? punch?.field_executive_id;
            const worker = accountId && profileType ? workerByKey.get(`${profileType}:${accountId}`) : undefined;
            const result = resultLabel(punch, alert);
            return <tr key={row.id}>
              <td><strong>{formatDashboardDateTime(row.punch_time ?? row.received_at ?? row.created_at)}</strong><small>Received {formatDashboardDateTime(row.created_at)}</small></td>
              <td>{device?.location_id ? locationById.get(device.location_id) || "-" : "-"}</td>
              <td><strong>{device?.device_no || row.device_serial}</strong><small>{row.device_serial}{device?.model ? ` · ${device.model}` : ""}</small></td>
              <td><strong>{row.enrolment_id || "-"}</strong><small>{profileType?.replaceAll("_", " ") || "Unmapped"}</small></td>
              <td><strong>{worker?.full_name || "Profile not mapped"}</strong><small>{worker?.code || "-"}</small></td>
              <td><strong>{row.trans_id || "-"}</strong><small>{row.terminal_id || "No terminal ID"}</small></td>
              <td><span className={`status-pill ${result === "Recorded" ? "good" : result === "Raw only" ? "warn" : "bad"}`}>{result}</span></td>
              <td>{alert?.message || (punch?.calculated ? "Included in attendance." : "Received but no attendance record was created.")}</td>
            </tr>;
          })}
          {!rows.length ? <tr><td className="empty-cell" colSpan={8}>No raw punch records found.</td></tr> : null}
        </tbody></table></div>
        <div className="verification-api-pagination"><Link aria-disabled={page <= 1} className={page <= 1 ? "button secondary disabled" : "button secondary"} href={page <= 1 ? "#" : pageHref(searchParams, page - 1)}>Previous</Link><span>Page {Math.min(page, totalPages)} of {totalPages}</span><Link aria-disabled={page >= totalPages} className={page >= totalPages ? "button secondary disabled" : "button secondary"} href={page >= totalPages ? "#" : pageHref(searchParams, page + 1)}>Next</Link></div>
      </section>
    </AppShell>
  );
}

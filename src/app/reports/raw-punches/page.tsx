import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { RawPunchReportFilters } from "@/components/raw-punch-report-filters";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import {
  buildRawPunchDeviceIndex,
  RAW_PUNCH_PROFILE_TABLES,
  rawPunchAccountId,
  rawPunchDeviceMatchLabel,
  rawPunchProfileType,
  rawPunchResultLabel,
  resolveRawPunchDevice,
  safeRawPunchDate,
  safeRawPunchSearch,
  type RawPunchAlertRow,
  type RawPunchDeviceRow,
  type RawPunchResultRow,
  type RawPunchRow,
  type RawPunchWorkerRow
} from "@/lib/biometric/raw-punch-report";
import { loadCurrentRawPunchMappingIds } from "@/lib/biometric/raw-punch-mapping";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type Params = {
  device?: string;
  from?: string;
  location?: string;
  mapping?: string;
  page?: string;
  per_page?: string;
  search?: string;
  to?: string;
};

type LocationRow = { id: string; station_code: string | null; station_name: string | null };

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pageHref(params: Params, page: number) {
  const next = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && key !== "page") next.set(key, value);
  });
  next.set("page", String(page));
  return `/reports/raw-punches?${next}`;
}

function selectedValues(value: string | undefined, allowed: string[]) {
  const allowedSet = new Set(allowed);
  return Array.from(new Set(String(value ?? "").split(",").map((item) => item.trim()).filter((item) => allowedSet.has(item))));
}

function exportHref(params: Params) {
  const next = new URLSearchParams();
  ["from", "to", "location", "device", "mapping", "search"].forEach((key) => {
    const value = params[key as keyof Params];
    if (value) next.set(key, value);
  });
  return `/api/reports/raw-punches/export${next.size ? `?${next}` : ""}`;
}

export default async function RawPunchesPage({ searchParams = {} }: { searchParams?: Params }) {
  const authorization = await requirePagePermission("raw_punch_reports", "access");
  const companyId = requireCompanyId(authorization);
  const page = positiveInteger(searchParams.page, 1);
  const requestedPageSize = positiveInteger(searchParams.per_page, 20);
  const pageSize = [20, 100, 500, 1000].includes(requestedPageSize) ? requestedPageSize : 20;
  const search = safeRawPunchSearch(searchParams.search);
  const from = safeRawPunchDate(searchParams.from);
  const to = safeRawPunchDate(searchParams.to);
  const mapping = selectedValues(searchParams.mapping, ["people", "workforce", "unmapped"]);
  let rows: RawPunchRow[] = [];
  let devices: RawPunchDeviceRow[] = [];
  let locations: LocationRow[] = [];
  let total = 0;
  let error: string | null = null;
  const punchByRawEvent = new Map<string, RawPunchResultRow>();
  const alertByRawEvent = new Map<string, RawPunchAlertRow>();
  const workerByKey = new Map<string, RawPunchWorkerRow>();
  const locationById = new Map<string, string>();

  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    const [deviceResult, locationResult] = await Promise.all([
      supabaseAdmin
        .from("biometric_devices")
        .select("id, device_no, terminal_id, device_serial, model, location_id, local_ip_address, last_source_ip")
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
      devices = ((deviceResult.data ?? []) as RawPunchDeviceRow[]).filter((device) =>
        authorization.hasAllLocationAccess || Boolean(device.location_id && allowedLocationIds.has(device.location_id))
      );
      locations = ((locationResult.data ?? []) as LocationRow[]).filter((location) =>
        authorization.hasAllLocationAccess || allowedLocationIds.has(location.id)
      );
      locations.forEach((location) => {
        locationById.set(location.id, [location.station_code, location.station_name].filter(Boolean).join(" - "));
      });

      const allowedDeviceIds = devices.map((device) => device.id);
      const selectedLocations = selectedValues(searchParams.location, locations.map((location) => location.id));
      const devicesForLocation = selectedLocations.length ? devices.filter((device) => Boolean(device.location_id && selectedLocations.includes(device.location_id))) : devices;
      const selectedDevices = selectedValues(searchParams.device, devicesForLocation.map((device) => device.id));
      if (authorization.hasAllLocationAccess || allowedDeviceIds.length) {
        let query = supabaseAdmin
          .from("biometric_raw_events")
          .select("id, device_id, device_serial, terminal_id, trans_id, enrolment_id, punch_time, received_at, event_type, source_ip, created_at", { count: "planned" })
          .eq("company_id", companyId)
          .eq("event_type", "TimeLog")
          .order("punch_time", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false });

        if (!authorization.hasAllLocationAccess) query = query.in("device_id", allowedDeviceIds);
        if (selectedLocations.length) {
          const locationDeviceIds = devicesForLocation.map((device) => device.id);
          query = locationDeviceIds.length ? query.in("device_id", locationDeviceIds) : query.eq("device_id", "__no_devices__");
        }
        if (selectedDevices.length) query = query.in("device_id", selectedDevices);
        if (from) query = query.gte("punch_time", `${from}T00:00:00+05:30`);
        if (to) query = query.lte("punch_time", `${to}T23:59:59.999+05:30`);
        if (search) {
          query = query.or(`enrolment_id.ilike.%${search}%,device_serial.ilike.%${search}%,terminal_id.ilike.%${search}%,trans_id.ilike.%${search}%`);
        }

        if (mapping.length && mapping.length < 3) {
          try {
            const { peopleIds, workforceIds } = await loadCurrentRawPunchMappingIds(companyId);
            const allMappedIds = Array.from(new Set([...peopleIds, ...workforceIds]));
            const includedIds = Array.from(new Set([
              ...(mapping.includes("people") ? peopleIds : []),
              ...(mapping.includes("workforce") ? workforceIds : [])
            ]));
            const includeUnmapped = mapping.includes("unmapped");
            if (!includeUnmapped) {
              query = includedIds.length ? query.in("enrolment_id", includedIds) : query.eq("enrolment_id", "__no_matching_profiles__");
            } else if (!mapping.includes("people") || !mapping.includes("workforce")) {
              const filters = ["enrolment_id.is.null"];
              if (includedIds.length) filters.push(`enrolment_id.in.(${includedIds.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(",")})`);
              if (allMappedIds.length) filters.push(`enrolment_id.not.in.(${allMappedIds.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(",")})`);
              query = query.or(filters.join(","));
            }
          } catch (mappingError) {
            error = mappingError instanceof Error ? mappingError.message : "Unable to validate profile mappings.";
          }
        }

        const result = error ? null : await query.range((page - 1) * pageSize, page * pageSize - 1);
        if (result?.error) {
          error = result.error.message;
        } else if (result) {
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
        ((punchResult.data ?? []) as RawPunchResultRow[]).forEach((item) => {
          if (item.raw_event_id) punchByRawEvent.set(item.raw_event_id, item);
        });
        ((alertResult.data ?? []) as RawPunchAlertRow[]).forEach((item) => {
          if (item.raw_event_id && !alertByRawEvent.has(item.raw_event_id)) alertByRawEvent.set(item.raw_event_id, item);
        });

        const idsByProfile = new Map<string, Set<string>>();
        punchByRawEvent.forEach((item) => {
          const profileType = rawPunchProfileType(item);
          const id = rawPunchAccountId(item);
          if (!profileType || !id) return;
          if (!idsByProfile.has(profileType)) idsByProfile.set(profileType, new Set());
          idsByProfile.get(profileType)!.add(id);
        });

        await Promise.all(Array.from(idsByProfile, async ([profileType, idSet]) => {
          const config = RAW_PUNCH_PROFILE_TABLES[profileType];
          if (!config || !idSet.size) return;
          await Promise.all(config.tables.map(async (table) => {
            const result = await supabaseAdmin!
              .from(table)
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
          }));
        })).catch((workerError) => {
          error = workerError instanceof Error ? workerError.message : "Unable to load worker names.";
        });
      }
    }
  }

  const deviceIndex = buildRawPunchDeviceIndex(devices);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppShell active="Raw Punches" pageCode="raw_punch_reports">
      <PageHead
        eyebrow="Reports"
        title="Raw Punches"
        subtitle="Every biometric TimeLog received from devices, including unmapped, inactive, duplicate, and rejected enrolment IDs."
        action={<a className="button secondary" download href={exportHref(searchParams)}>Download Excel</a>}
      />
      {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load raw punches</strong><p className="subtle">{error}</p></div></section> : null}
      <section className="panel">
        <RawPunchReportFilters
          deviceOptions={devices.map((device) => ({
            value: device.id,
            scope: device.location_id,
            label: `${device.location_id ? locationById.get(device.location_id) ?? "Unknown location" : "Unknown location"} · ${device.device_no || device.terminal_id || device.device_serial}`
          }))}
          locationOptions={locations.map((location) => ({ value: location.id, label: [location.station_code, location.station_name].filter(Boolean).join(" - ") }))}
        />
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Complete device punch history</h2><p className="subtle">{total ? `Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total} raw punches.` : "No matching raw punches."} Newest punches are shown first.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Punch time</th><th>Location</th><th>Device</th><th>Enrolment / mapping</th><th>Employee / workforce</th><th>Transaction</th><th>Capture result</th><th>Reason</th></tr></thead><tbody>
          {rows.map((row) => {
            const resolvedDevice = resolveRawPunchDevice(row, deviceIndex);
            const device = resolvedDevice.device;
            const punch = punchByRawEvent.get(row.id);
            const alert = alertByRawEvent.get(row.id);
            const profileType = rawPunchProfileType(punch);
            const accountId = rawPunchAccountId(punch);
            const worker = accountId && profileType ? workerByKey.get(`${profileType}:${accountId}`) : undefined;
            const result = rawPunchResultLabel(punch, alert);
            return <tr key={row.id}>
              <td><strong>{formatDashboardDateTime(row.punch_time ?? row.received_at ?? row.created_at)}</strong><small>Received {formatDashboardDateTime(row.created_at)}</small></td>
              <td><strong>{device?.location_id ? locationById.get(device.location_id) || "-" : "-"}</strong><small>{rawPunchDeviceMatchLabel(resolvedDevice.match)}</small></td>
              <td><strong>{device?.device_no || row.device_serial}</strong><small>{row.device_serial}{device?.model ? ` · ${device.model}` : ""}</small></td>
              <td><strong>{row.enrolment_id || "-"}</strong><small>{worker ? profileType === "employee" ? "People / HR" : "Workforce" : "Not mapped in either"}</small></td>
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

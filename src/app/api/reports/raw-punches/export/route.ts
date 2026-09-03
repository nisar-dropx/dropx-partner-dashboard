import { type NextRequest } from "next/server";
import { Readable } from "node:stream";
import { requirePagePermission } from "@/lib/authorization";
import {
  buildRawPunchDeviceIndex,
  normalizedEnrolmentId,
  RAW_PUNCH_PROFILE_TABLES,
  rawPunchDeviceMatchLabel,
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
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createStreamingXlsx } from "@/lib/xlsx-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type LocationRow = { id: string; station_code: string | null; station_name: string | null };

function selectedValues(value: string | null, allowed: string[]) {
  const allowedSet = new Set(allowed);
  return Array.from(new Set(String(value ?? "").split(",").map((item) => item.trim()).filter((item) => allowedSet.has(item))));
}

function chunks<T>(values: T[], size = 200) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function excelFileName() {
  return `raw-punches-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await requirePagePermission("raw_punch_reports", "access");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) return Response.json({ error: "The report service is unavailable. Please try again." }, { status: 500 });
    const admin = supabaseAdmin;

    const params = request.nextUrl.searchParams;
    const from = safeRawPunchDate(params.get("from"));
    const to = safeRawPunchDate(params.get("to"));
    const search = safeRawPunchSearch(params.get("search"));
    const mapping = selectedValues(params.get("mapping"), ["people", "workforce", "unmapped"]);
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
      throw new Error(deviceResult.error?.message ?? locationResult.error?.message ?? "Unable to load report filters.");
    }

    const allowedLocationIds = new Set(authorization.locationScopeIds);
    const devices = ((deviceResult.data ?? []) as RawPunchDeviceRow[]).filter((device) =>
      authorization.hasAllLocationAccess || Boolean(device.location_id && allowedLocationIds.has(device.location_id))
    );
    const locations = ((locationResult.data ?? []) as LocationRow[]).filter((location) =>
      authorization.hasAllLocationAccess || allowedLocationIds.has(location.id)
    );
    const selectedLocations = selectedValues(params.get("location"), locations.map((location) => location.id));
    const devicesForLocation = selectedLocations.length
      ? devices.filter((device) => Boolean(device.location_id && selectedLocations.includes(device.location_id)))
      : devices;
    const selectedDevices = selectedValues(params.get("device"), devicesForLocation.map((device) => device.id));
    const allowedDeviceIds = devices.map((device) => device.id);
    const locationById = new Map(locations.map((location) => [
      location.id,
      [location.station_code, location.station_name].filter(Boolean).join(" - ")
    ]));

    const { mappings: currentMappings, peopleIds, workforceIds } = await loadCurrentRawPunchMappingIds(companyId);

    const batchSize = 1000;
    const exportCutoff = new Date().toISOString();
    const allMappedIds = Array.from(new Set([...peopleIds, ...workforceIds]));
    const includedIds = Array.from(new Set([
      ...(mapping.includes("people") ? peopleIds : []),
      ...(mapping.includes("workforce") ? workforceIds : [])
    ]));
    const includeUnmapped = mapping.includes("unmapped");

    async function loadRawEventBatch(offset: number, includeCount = false) {
      let query = admin
        .from("biometric_raw_events")
        .select(
          "id, device_id, device_serial, terminal_id, trans_id, enrolment_id, punch_time, received_at, event_type, source_ip, worker_status, created_at",
          includeCount ? { count: "exact" } : undefined
        )
        .eq("company_id", companyId)
        .eq("event_type", "TimeLog")
        .lte("created_at", exportCutoff)
        .order("punch_time", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (!authorization.hasAllLocationAccess) {
        query = allowedDeviceIds.length ? query.in("device_id", allowedDeviceIds) : query.eq("device_id", "__no_authorized_devices__");
      }
      if (selectedLocations.length) {
        const locationDeviceIds = devicesForLocation.map((device) => device.id);
        query = locationDeviceIds.length ? query.in("device_id", locationDeviceIds) : query.eq("device_id", "__no_devices__");
      }
      if (selectedDevices.length) query = query.in("device_id", selectedDevices);
      if (from) query = query.gte("punch_time", `${from}T00:00:00+05:30`);
      if (to) query = query.lte("punch_time", `${to}T23:59:59.999+05:30`);
      if (search) query = query.or(`enrolment_id.ilike.%${search}%,device_serial.ilike.%${search}%,terminal_id.ilike.%${search}%,trans_id.ilike.%${search}%`);

      if (mapping.length && mapping.length < 3) {
        if (!includeUnmapped) {
          query = includedIds.length ? query.in("enrolment_id", includedIds) : query.eq("enrolment_id", "__no_matching_profiles__");
        } else if (!mapping.includes("people") || !mapping.includes("workforce")) {
          const filters = ["enrolment_id.is.null"];
          if (includedIds.length) filters.push(`enrolment_id.in.(${includedIds.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(",")})`);
          if (allMappedIds.length) filters.push(`enrolment_id.not.in.(${allMappedIds.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(",")})`);
          query = query.or(filters.join(","));
        }
      }

      const response = await query.range(offset, offset + batchSize - 1);
      if (response.error) throw new Error(response.error.message);
      return {
        rows: (response.data ?? []) as RawPunchRow[],
        total: response.count ?? 0
      };
    }

    const firstBatch = await loadRawEventBatch(0, true);
    const rows = [...firstBatch.rows];
    const remainingOffsets = Array.from(
      { length: Math.max(Math.ceil(firstBatch.total / batchSize) - 1, 0) },
      (_, index) => (index + 1) * batchSize
    );
    for (const offsetGroup of chunks(remainingOffsets, 8)) {
      const batches = await Promise.all(offsetGroup.map((offset) => loadRawEventBatch(offset)));
      batches.forEach((batch) => rows.push(...batch.rows));
    }

    // Processing-history enrichment is useful for a focused export, but scanning every
    // historical attendance/alert row for a full raw-punch export is prohibitively
    // expensive. The raw event, current profile mapping, worker and location data remain
    // complete for large exports; only the derived capture explanation falls back to the
    // status stored on the raw event itself.
    const enrichProcessingHistory = rows.length <= 5_000;
    const rawEventIds = enrichProcessingHistory ? new Set(rows.map((row) => row.id)) : new Set<string>();
    const processingDeviceIds = selectedDevices.length
      ? selectedDevices
      : selectedLocations.length
        ? devicesForLocation.map((device) => device.id)
        : authorization.hasAllLocationAccess
          ? []
          : allowedDeviceIds;
    const scopeProcessingByDevice = selectedDevices.length > 0 || selectedLocations.length > 0 || !authorization.hasAllLocationAccess;
    const [processingPunches, processingAlerts] = rows.length && enrichProcessingHistory ? await Promise.all([
      (async () => {
        const result: RawPunchResultRow[] = [];
        for (let offset = 0; ; offset += batchSize) {
          let query = admin
            .from("attendance_punches")
            .select("raw_event_id, profile_type, account_id, employee_id, field_executive_id, worker_status, calculated")
            .eq("company_id", companyId)
            .order("punch_time", { ascending: false });
          if (scopeProcessingByDevice) {
            query = processingDeviceIds.length ? query.in("device_id", processingDeviceIds) : query.eq("device_id", "__no_authorized_devices__");
          }
          if (from) query = query.gte("punch_time", `${from}T00:00:00+05:30`);
          if (to) query = query.lte("punch_time", `${to}T23:59:59.999+05:30`);
          const response = await query.range(offset, offset + batchSize - 1);
          if (response.error) throw new Error(response.error.message);
          const batch = (response.data ?? []) as RawPunchResultRow[];
          result.push(...batch.filter((item) => Boolean(item.raw_event_id && rawEventIds.has(item.raw_event_id))));
          if (batch.length < batchSize) break;
        }
        return result;
      })(),
      (async () => {
        const result: Array<RawPunchAlertRow & { created_at: string }> = [];
        for (let offset = 0; ; offset += batchSize) {
          let query = admin
            .from("biometric_alerts")
            .select("raw_event_id, alert_type, message, created_at")
            .eq("company_id", companyId)
            .order("created_at", { ascending: false });
          if (scopeProcessingByDevice) {
            query = processingDeviceIds.length ? query.in("device_id", processingDeviceIds) : query.eq("device_id", "__no_authorized_devices__");
          }
          if (from) query = query.gte("punch_time", `${from}T00:00:00+05:30`);
          if (to) query = query.lte("punch_time", `${to}T23:59:59.999+05:30`);
          const response = await query.range(offset, offset + batchSize - 1);
          if (response.error) throw new Error(response.error.message);
          const batch = (response.data ?? []) as Array<RawPunchAlertRow & { created_at: string }>;
          result.push(...batch.filter((item) => Boolean(item.raw_event_id && rawEventIds.has(item.raw_event_id))));
          if (batch.length < batchSize) break;
        }
        return result;
      })()
    ]) : [[], []];
    const punchByRawEvent = new Map<string, RawPunchResultRow>();
    const alertByRawEvent = new Map<string, RawPunchAlertRow>();
    processingPunches.forEach((item) => {
      if (item.raw_event_id) punchByRawEvent.set(item.raw_event_id, item);
    });
    processingAlerts.forEach((item) => {
      if (item.raw_event_id && !alertByRawEvent.has(item.raw_event_id)) alertByRawEvent.set(item.raw_event_id, item);
    });

    const idsByProfile = new Map<string, Set<string>>();
    currentMappings.forEach((currentMapping) => {
      if (!idsByProfile.has(currentMapping.profileType)) idsByProfile.set(currentMapping.profileType, new Set());
      idsByProfile.get(currentMapping.profileType)!.add(currentMapping.accountId);
    });
    const workerByKey = new Map<string, RawPunchWorkerRow>();
    for (const [profileType, idSet] of idsByProfile) {
      const config = RAW_PUNCH_PROFILE_TABLES[profileType];
      if (!config) continue;
      for (const table of config.tables) {
        for (const profileIds of chunks(Array.from(idSet))) {
          const profiles = await supabaseAdmin
            .from(table)
            .select(`id, full_name, ${config.code}`)
            .eq("company_id", companyId)
            .in("id", profileIds);
          if (profiles.error) throw new Error(profiles.error.message);
          ((profiles.data ?? []) as unknown as Array<Record<string, string | null>>).forEach((profile) => {
            workerByKey.set(`${profileType}:${profile.id}`, {
              id: String(profile.id),
              full_name: profile.full_name ?? null,
              code: String(profile[config.code] ?? "") || null
            });
          });
        }
      }
    }

    const deviceIndex = buildRawPunchDeviceIndex(devices);
    const currentMappingByEnrolment = new Map(currentMappings.map((item) => [item.enrolmentId, item]));
    function* excelRows() {
      for (const row of rows) {
        const punch = punchByRawEvent.get(row.id);
        const alert = alertByRawEvent.get(row.id);
        const resolvedDevice = resolveRawPunchDevice(row, deviceIndex);
        const device = resolvedDevice.device;
        const enrolmentId = normalizedEnrolmentId(row.enrolment_id);
        const currentMapping = currentMappingByEnrolment.get(enrolmentId);
        const profileType = currentMapping?.profileType ?? null;
        const worker = currentMapping ? workerByKey.get(`${currentMapping.profileType}:${currentMapping.accountId}`) : undefined;
        const mappingLabel = currentMapping?.profileType === "employee"
          ? "Mapped in People / HR"
          : currentMapping
            ? "Mapped in Workforce"
            : "Not mapped in either";
        yield [
          formatDashboardDateTime(row.punch_time ?? row.received_at ?? row.created_at),
          formatDashboardDateTime(row.created_at),
          device?.location_id ? locationById.get(device.location_id) ?? "" : "",
          rawPunchDeviceMatchLabel(resolvedDevice.match),
          device?.device_no || device?.terminal_id || row.device_serial,
          row.device_serial,
          device?.model ?? "",
          row.terminal_id ?? "",
          row.source_ip ?? "",
          row.enrolment_id ?? "",
          mappingLabel,
          profileType?.replaceAll("_", " ") ?? "",
          worker?.full_name ?? "",
          worker?.code ?? "",
          row.trans_id ?? "",
          enrichProcessingHistory
            ? rawPunchResultLabel(punch, alert)
            : row.worker_status === "inactive"
              ? "Inactive worker"
              : currentMapping
                ? "Recorded"
                : "Unmapped ID",
          enrichProcessingHistory
            ? alert?.message ?? (punch?.calculated ? "Included in attendance." : "Received but no attendance record was created.")
            : currentMapping
              ? "Raw biometric event received; current profile mapping included."
              : "Raw biometric event received; no current People or Workforce mapping found."
        ];
      }
    }

    const workbookStream = createStreamingXlsx({
      sheetName: "Raw Punches",
      headers: [
        "Punch time", "Received at", "Location", "Location identified by", "Device", "Device serial",
        "Device model", "Terminal ID", "Source IP", "Enrolment ID", "Profile mapping", "Profile category",
        "Employee / workforce name", "DropX / employee ID", "Transaction ID", "Capture result", "Reason"
      ],
      columnWidths: [22, 22, 28, 23, 18, 18, 16, 16, 18, 16, 25, 22, 30, 20, 18, 20, 58],
      rows: excelRows()
    });
    return new Response(Readable.toWeb(workbookStream) as unknown as BodyInit, {
      headers: {
        "Content-Disposition": `attachment; filename="${excelFileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Cache-Control": "private, max-age=0, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("Raw Punches export failed", error);
    return Response.json({ error: "Unable to prepare the Excel report. Please try again." }, { status: 500 });
  }
}

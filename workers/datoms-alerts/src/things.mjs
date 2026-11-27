import { ALLOWED_STATIONS, extractStationCode } from "./stations.mjs";

function clean(v) {
  return String(v ?? "").trim();
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function thingId(row) {
  return clean(row?.id ?? row?.thing_id ?? row?.thingId ?? row?.entity_id ?? "");
}

function thingName(row) {
  return (
    clean(row?.name ?? row?.thing_name ?? row?.display_name ?? row?.station_name ?? row?.title)
    || "—"
  );
}

function thingCategory(row) {
  return (
    clean(
      row?.thing_category_name
        ?? row?.category_name
        ?? row?.category
        ?? row?.thing_type
        ?? row?.type_name
        ?? row?.icon
    ) || null
  );
}

function pickMetrics(row) {
  const metrics = {};
  const sources = [
    asObject(row?.metrics),
    asObject(row?.data),
    asObject(row?.live_data),
    asObject(row?.parameters),
    asObject(row?.values)
  ];
  for (const src of sources) {
    for (const [key, value] of Object.entries(src)) {
      if (value == null) continue;
      if (typeof value === "object" && !Array.isArray(value)) {
        const num = value.value ?? value.val ?? value.reading ?? value.latest;
        if (num != null && metrics[key] == null) {
          metrics[key] = {
            value: num,
            unit: value.unit ?? value.uom ?? null,
            label: value.label ?? value.name ?? key
          };
        }
      } else if (typeof value === "number" || (typeof value === "string" && value !== "")) {
        if (metrics[key] == null) metrics[key] = { value, unit: null, label: key };
      }
    }
  }
  // Flatten common top-level fields used by Panel View.
  for (const key of [
    "temperature", "humidity", "avg_ln_voltage", "total_active_power",
    "condensing_unit_status", "heater_status", "voltage", "power"
  ]) {
    if (row?.[key] != null && metrics[key] == null) {
      metrics[key] = { value: row[key], unit: null, label: key };
    }
  }
  return metrics;
}

function pickStatus(row) {
  const onlineRaw = row?.online ?? row?.is_online ?? row?.connected ?? row?.status;
  let online = null;
  if (typeof onlineRaw === "boolean") online = onlineRaw;
  else if (typeof onlineRaw === "string") {
    const s = onlineRaw.toLowerCase();
    if (["online", "connected", "on", "true", "1"].includes(s)) online = true;
    if (["offline", "disconnected", "off", "false", "0"].includes(s)) online = false;
  } else if (typeof onlineRaw === "number") online = onlineRaw !== 0;

  return {
    online,
    condensingUnit: clean(row?.condensing_unit_status ?? row?.condensingUnitStatus ?? "") || null,
    heater: clean(row?.heater_status ?? row?.heaterStatus ?? "") || null,
    lastSeen: clean(row?.last_seen ?? row?.updated_at ?? row?.observed_at ?? row?.timestamp ?? "") || null
  };
}

/**
 * Normalize a Datoms thing row into a snapshot for OpsPulse Panel / List.
 * Drops assets outside the DropX station allowlist when a station can be inferred.
 */
export function normalizeThing(row) {
  if (!row || typeof row !== "object") return null;
  const id = thingId(row);
  if (!id) return null;
  const name = thingName(row);
  const siteName = clean(row?.site_name ?? row?.siteName ?? row?.site?.name ?? "") || null;
  const station =
    extractStationCode(siteName, name, row?.station_name, row?.station_code, row?.location_name)
    || null;
  // Panel/List are store-scoped — only keep assets we can map to a DropX Datoms station.
  if (!station || !ALLOWED_STATIONS.has(station)) return null;

  return {
    thingId: id,
    stationCode: station,
    name,
    category: thingCategory(row),
    siteName: siteName || station,
    metrics: pickMetrics(row),
    status: pickStatus(row),
    raw: row
  };
}

/** Merge list + data payloads by thing id (data wins for metrics). */
export function mergeThingRows(listRows, dataRows) {
  const byId = new Map();
  for (const row of listRows || []) {
    const id = thingId(row);
    if (!id) continue;
    byId.set(id, { ...row });
  }
  for (const row of dataRows || []) {
    const id = thingId(row);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...row });
  }
  return [...byId.values()];
}

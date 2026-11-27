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

const CATEGORY_LABELS = {
  123: "Compressor",
  118: "Cold room",
  124: "Tropical",
  112: "Sensor",
  108: "DG",
  107: "Meter"
};

/** Panel card priority — mirrors Datoms panel-view parameter order. */
const PANEL_METRIC_KEYS = [
  "mvol",
  "mt_power",
  "mcurr",
  "mvolt_p",
  "mt_energy",
  "ma_energy",
  "mr_energy",
  "mpf",
  "mfreq",
  "temperature",
  "humidity"
];

function thingCategory(row) {
  const raw =
    row?.thing_category_name
    ?? row?.category_name
    ?? row?.thing_type
    ?? row?.type_name
    ?? row?.category
    ?? row?.icon;
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" || /^\d+$/.test(String(raw).trim())) {
    const id = Number(raw);
    return CATEGORY_LABELS[id] || `Category ${id}`;
  }
  return clean(raw) || null;
}

function ingestMetric(metrics, key, value, unit, label, order = 999) {
  const k = clean(key);
  if (!k || value == null || value === "") return;
  if (metrics[k]) return;
  metrics[k] = {
    value,
    unit: unit ? String(unit) : null,
    label: clean(label) || k,
    order
  };
}

function pickMetrics(row) {
  const metrics = {};

  // Datoms things/list returns live readings as parameters: [{ key, name, unit, value, type }]
  if (Array.isArray(row?.parameters)) {
    for (const [idx, param] of row.parameters.entries()) {
      if (!param || typeof param !== "object") continue;
      const key = param.key ?? param.destination_key ?? param.source_key;
      ingestMetric(
        metrics,
        key,
        param.value ?? param.latest ?? param.reading,
        param.unit ?? param.default_unit ?? param.param_details?.default_unit,
        param.name ?? param.custom_name ?? param.label ?? param.param_details?.name,
        Number(param.param_details?.order ?? param.order ?? idx)
      );
    }
  }

  const sources = [
    asObject(row?.metrics),
    asObject(row?.data),
    asObject(row?.live_data),
    asObject(row?.values),
    // Object-shaped parameters (from things/data merge)
    !Array.isArray(row?.parameters) ? asObject(row?.parameters) : {}
  ];
  for (const src of sources) {
    for (const [key, value] of Object.entries(src)) {
      if (value == null) continue;
      if (typeof value === "object" && !Array.isArray(value)) {
        ingestMetric(
          metrics,
          key,
          value.value ?? value.val ?? value.reading ?? value.latest,
          value.unit ?? value.uom,
          value.label ?? value.name ?? key
        );
      } else if (typeof value === "number" || (typeof value === "string" && value !== "")) {
        ingestMetric(metrics, key, value, null, key);
      }
    }
  }

  for (const key of [
    "temperature", "humidity", "avg_ln_voltage", "total_active_power",
    "condensing_unit_status", "heater_status", "voltage", "power"
  ]) {
    if (row?.[key] != null) ingestMetric(metrics, key, row[key], null, key);
  }

  return metrics;
}

function statusFromMachine(metrics) {
  const mc = metrics.mc_st?.value;
  if (mc == null) return null;
  const n = Number(mc);
  if (Number.isFinite(n)) return n > 0 ? "On" : "Off";
  const s = String(mc).toLowerCase();
  if (["1", "on", "true", "running"].includes(s)) return "On";
  if (["0", "off", "false", "stopped"].includes(s)) return "Off";
  return null;
}

function pickStatus(row, metrics = {}) {
  const onlineRaw = row?.online ?? row?.is_online ?? row?.connected ?? row?.status ?? row?.status_code;
  let online = null;
  if (typeof onlineRaw === "boolean") online = onlineRaw;
  else if (typeof onlineRaw === "string") {
    const s = onlineRaw.toLowerCase();
    if (["online", "connected", "on", "true", "1"].includes(s)) online = true;
    if (["offline", "disconnected", "off", "false", "0"].includes(s)) online = false;
  } else if (typeof onlineRaw === "number") online = onlineRaw !== 0;

  const machine = statusFromMachine(metrics);
  const heaterFromMetric = (() => {
    const h = metrics.heater_st?.value ?? metrics.ht_st?.value;
    if (h == null) return null;
    const n = Number(h);
    if (Number.isFinite(n)) return n > 0 ? "On" : "Off";
    const s = String(h).toLowerCase();
    if (["1", "on", "true"].includes(s)) return "On";
    if (["0", "off", "false"].includes(s)) return "Off";
    return clean(h) || null;
  })();
  const lastRaw =
    row?.last_data_received_time
    ?? row?.last_seen
    ?? row?.updated_at
    ?? row?.observed_at
    ?? row?.timestamp
    ?? null;
  let lastSeen = null;
  if (lastRaw != null && lastRaw !== "") {
    if (typeof lastRaw === "number" || /^\d+(\.\d+)?$/.test(String(lastRaw).trim())) {
      const n = Number(lastRaw);
      const ms = n > 1e12 ? n : n * 1000;
      lastSeen = new Date(ms).toISOString();
    } else {
      const d = new Date(String(lastRaw));
      lastSeen = Number.isNaN(d.getTime()) ? clean(lastRaw) : d.toISOString();
    }
  }
  return {
    online,
    condensingUnit:
      clean(row?.condensing_unit_status ?? row?.condensingUnitStatus ?? "")
      || (metrics.con_st?.value != null
        ? (Number(metrics.con_st.value) > 0 || String(metrics.con_st.value).toLowerCase() === "on" ? "On" : "Off")
        : null)
      || machine
      || null,
    heater: clean(row?.heater_status ?? row?.heaterStatus ?? "") || heaterFromMetric,
    machine,
    lastSeen
  };
}

/** Prefer panel-relevant metrics in Datoms order for cards. */
export function panelMetricList(metrics, { limit = 6 } = {}) {
  const entries = Object.entries(metrics || {}).map(([key, raw]) => {
    const obj = raw && typeof raw === "object" ? raw : { value: raw, label: key };
    return {
      key,
      label: String(obj.label || key),
      value: obj.value == null ? "—" : String(obj.value),
      unit: obj.unit ? String(obj.unit) : "",
      order: Number(obj.order ?? 999)
    };
  });
  entries.sort((a, b) => {
    const ai = PANEL_METRIC_KEYS.indexOf(a.key);
    const bi = PANEL_METRIC_KEYS.indexOf(b.key);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.order - b.order || a.label.localeCompare(b.label);
  });
  return entries
    .filter((m) => !["mc_st"].includes(m.key))
    .slice(0, Math.max(1, limit));
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

  const metrics = pickMetrics(row);
  return {
    thingId: id,
    stationCode: station,
    name,
    category: thingCategory(row),
    siteName: siteName || station,
    metrics,
    status: pickStatus(row, metrics),
    raw: row
  };
}

function mergeParameterArrays(listParams, dataParams) {
  const byKey = new Map();
  for (const param of Array.isArray(listParams) ? listParams : []) {
    const key = clean(param?.key ?? param?.destination_key ?? param?.name);
    if (!key) continue;
    byKey.set(key, { ...param });
  }
  for (const param of Array.isArray(dataParams) ? dataParams : []) {
    const key = clean(param?.key ?? param?.destination_key ?? param?.name);
    if (!key) continue;
    const prev = byKey.get(key) || {};
    byKey.set(key, {
      ...prev,
      ...param,
      // Keep human labels/units from things/list when data only has raw keys.
      name: prev.name || prev.custom_name || param.name || key,
      unit: prev.unit || prev.default_unit || param.unit || "",
      key,
      value: param.value ?? param.latest ?? prev.value
    });
  }
  return [...byKey.values()];
}

/** Merge list + data payloads by thing id (data fills live values; list keeps labels). */
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
    const prev = byId.get(id) || {};
    const parameters = mergeParameterArrays(prev.parameters, row.parameters);
    byId.set(id, {
      ...prev,
      ...row,
      parameters: parameters.length ? parameters : prev.parameters || row.parameters,
      // Prefer richer list identity fields over sparse data rows.
      name: prev.name || row.name,
      site_name: prev.site_name || row.site_name,
      thing_category_name: prev.thing_category_name || row.thing_category_name,
      online: row.online ?? prev.online
    });
  }
  return [...byId.values()];
}

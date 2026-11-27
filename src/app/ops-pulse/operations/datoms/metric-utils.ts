/** Shared metric helpers for Datoms Panel / List / Detailed / Analog. */

export type MetricEntry = {
  key: string;
  label: string;
  value: string;
  unit: string;
  order: number;
  numeric: number | null;
};

const PANEL_KEYS = [
  "mvol",
  "mt_power",
  "mcurr",
  "mvolt_p",
  "mt_energy",
  "ma_energy",
  "mr_energy",
  "mpf",
  "mt_pf",
  "mfreq",
  "temperature",
  "humidity"
];

const ANALOG_KEYS = [
  "mt_power",
  "mvol",
  "mcurr",
  "mt_energy",
  "mvolt_p",
  "mr_energy",
  "ma_energy",
  "mt_pf",
  "mpf",
  "mfreq"
];

const HIDDEN = new Set(["mc_st", "con_st", "heater_st", "ht_st"]);

function toEntry(key: string, raw: unknown, order = 999): MetricEntry | null {
  if (HIDDEN.has(key)) return null;
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as { value?: unknown; unit?: string | null; label?: string; order?: number };
    if (obj.value == null || obj.value === "") return null;
    const numeric = Number(obj.value);
    return {
      key,
      label: String(obj.label || key),
      value: String(obj.value),
      unit: obj.unit ? String(obj.unit) : "",
      order: Number(obj.order ?? order),
      numeric: Number.isFinite(numeric) ? numeric : null
    };
  }
  const numeric = Number(raw);
  return {
    key,
    label: key,
    value: String(raw),
    unit: "",
    order,
    numeric: Number.isFinite(numeric) ? numeric : null
  };
}

export function allMetrics(metrics: Record<string, unknown> | null | undefined): MetricEntry[] {
  const entries: MetricEntry[] = [];
  for (const [key, raw] of Object.entries(metrics || {})) {
    const entry = toEntry(key, raw);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return entries;
}

export function panelMetrics(
  metrics: Record<string, unknown> | null | undefined,
  limit = 5
): MetricEntry[] {
  const all = allMetrics(metrics);
  const preferred = PANEL_KEYS.map((key) => all.find((m) => m.key === key)).filter(
    (m): m is MetricEntry => Boolean(m)
  );
  if (preferred.length >= Math.min(3, limit)) return preferred.slice(0, limit);
  const rest = all.filter((m) => !preferred.some((p) => p.key === m.key));
  return [...preferred, ...rest].slice(0, limit);
}

export function analogMetrics(metrics: Record<string, unknown> | null | undefined): MetricEntry[] {
  const all = allMetrics(metrics);
  const preferred = ANALOG_KEYS.map((key) => all.find((m) => m.key === key)).filter(
    (m): m is MetricEntry => Boolean(m)
  );
  if (preferred.length) return preferred;
  return all.slice(0, 9);
}

export function formatMetricValue(entry: MetricEntry) {
  if (entry.numeric == null) return entry.value;
  const abs = Math.abs(entry.numeric);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return entry.numeric.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0
  });
}

export function statusChips(status: Record<string, unknown> | null | undefined) {
  const chips: { label: string; value: string }[] = [];
  if (!status) return chips;
  if (status.condensingUnit) chips.push({ label: "Condensing Unit", value: String(status.condensingUnit) });
  if (status.heater) chips.push({ label: "Heater", value: String(status.heater) });
  if (status.machine && !status.condensingUnit) chips.push({ label: "Machine", value: String(status.machine) });
  return chips;
}

/** Simple 0–100 gauge fill from typical electrical ranges. */
export function gaugePct(entry: MetricEntry) {
  if (entry.numeric == null) return 0;
  const n = Math.abs(entry.numeric);
  const key = entry.key;
  if (key.includes("pf") || key === "mpf" || key === "mt_pf") return Math.min(100, n * 100);
  if (key.includes("freq") || key === "mfreq") return Math.min(100, (n / 60) * 100);
  if (key.includes("vol") || key === "mvol" || key === "mvolt_p") return Math.min(100, (n / 480) * 100);
  if (key.includes("curr") || key === "mcurr") return Math.min(100, (n / 40) * 100);
  if (key.includes("power") || key === "mt_power") return Math.min(100, (n / 15) * 100);
  if (key.includes("energy")) return Math.min(100, (n % 1000) / 10);
  return Math.min(100, n % 100);
}

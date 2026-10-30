/** Quick Commerce Store Health Scorecard (v6.2) — PDF parse + metric catalog for Dark Store Review Desk. */

/** Keep in sync with performance-source-policy.STORE_HEALTH_DAILY_SOURCE */
export const STORE_HEALTH_DAILY_SOURCE = "qc_store_health_daily" as const;
export const STORE_HEALTH_DAILY_SOURCE_LABEL = "Store Health D-2";
export const STORE_HEALTH_PARSER_TYPE = "qc_store_health_pdf" as const;
export const STORE_HEALTH_FORMAT_VERSION = 1;

export type StoreHealthBand = "Healthy" | "Watch" | "Critical";
export type StoreHealthMetricStatus = "Green" | "Amber" | "Red" | "Not scored";

export type StoreHealthMetricDefinition = {
  key: string;
  label: string;
  category: string;
  short: string;
  targetText: string;
  weight: number;
  direction: "higher" | "lower";
};

export type StoreHealthMetricValue = {
  actual_text: string;
  actual_number: number | null;
  target_text: string;
  status: StoreHealthMetricStatus;
  weight: number;
  points: number | null;
  scored: boolean;
};

export type StoreHealthStoreRow = {
  stationCode: string;
  city: string | null;
  scorePct: number;
  band: StoreHealthBand;
  pointsEarned: number;
  pointsAvailable: number;
  insights: { network?: string; store?: string };
  metrics: Record<string, StoreHealthMetricValue>;
  pageNumber: number;
  rawText: string;
};

export type StoreHealthParseResult = {
  performanceDate: string;
  stores: StoreHealthStoreRow[];
  metricsVersion: string | null;
};

export const storeHealthMetricDefinitions: StoreHealthMetricDefinition[] = [
  { key: "order_drop_to_picker_acceptance", label: "Order drop to picker acceptance", category: "SPEED & PRODUCTIVITY", short: "Drop→accept", targetText: "30 s", weight: 15, direction: "lower" },
  { key: "ppi", label: "PPI", category: "SPEED & PRODUCTIVITY", short: "PPI", targetText: "20/30 s", weight: 10, direction: "lower" },
  { key: "stowed_within_sla", label: "Stowed within SLA", category: "INBOUND & LOSS", short: "Stow SLA", targetText: "95%", weight: 10, direction: "higher" },
  { key: "shorts_per_1000_orders", label: "Shorts per 1,000 orders", category: "INBOUND & LOSS", short: "Shorts/1k", targetText: "0", weight: 5, direction: "lower" },
  { key: "reconciliation", label: "Reconciliation", category: "INBOUND & LOSS", short: "Recon", targetText: "98.5%", weight: 5, direction: "higher" },
  { key: "loss_rate", label: "Loss rate", category: "INBOUND & LOSS", short: "Loss", targetText: "<1.5%", weight: 5, direction: "lower" },
  { key: "iol_aged_7_plus", label: "IOL aged 7+ days", category: "INBOUND & LOSS", short: "IOL 7+", targetText: "0", weight: 5, direction: "lower" },
  { key: "count_compliance", label: "Count compliance", category: "INVENTORY ACCURACY & EXPIRY", short: "Count", targetText: "100%", weight: 5, direction: "higher" },
  { key: "sbc_defect_rate", label: "SBC defect rate", category: "INVENTORY ACCURACY & EXPIRY", short: "SBC", targetText: "<=2%", weight: 5, direction: "lower" },
  { key: "irdr_ermr", label: "IRDR & ERMR", category: "INVENTORY ACCURACY & EXPIRY", short: "IRDR/ERMR", targetText: "TBC", weight: 5, direction: "higher" },
  { key: "guided_removal_task", label: "Guided removal task", category: "INVENTORY ACCURACY & EXPIRY", short: "Guided rem.", targetText: "100%", weight: 5, direction: "higher" },
  { key: "expiry_awareness", label: "Expiry awareness", category: "INVENTORY ACCURACY & EXPIRY", short: "Expiry", targetText: "100%", weight: 5, direction: "higher" },
  { key: "yms", label: "YMS", category: "TOOLS & PROCESS", short: "YMS", targetText: "100%", weight: 3, direction: "higher" },
  { key: "tote_tools", label: "Tote tools", category: "TOOLS & PROCESS", short: "Tote tools", targetText: "100%", weight: 3, direction: "higher" },
  { key: "clear_audit", label: "CLEAR audit", category: "TOOLS & PROCESS", short: "CLEAR", targetText: "Pass", weight: 3, direction: "higher" },
  { key: "slack_response", label: "Slack response", category: "TOOLS & PROCESS", short: "Slack", targetText: "100%", weight: 3, direction: "higher" },
  { key: "apollo_audit", label: "Apollo audit", category: "TOOLS & PROCESS", short: "Apollo", targetText: "85%+", weight: 5, direction: "higher" },
  { key: "picker_hc_vs_approved", label: "Picker HC vs approved", category: "PEOPLE", short: "Picker HC", targetText: "100%", weight: 3, direction: "higher" }
];

const MONTHS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12"
};

const LABEL_BY_KEY = new Map(storeHealthMetricDefinitions.map((metric) => [metric.key, metric.label]));

function clean(value: unknown) {
  return String(value ?? "").trim().replace(/\u0000/g, "");
}

function normalizeSpace(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeStation(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseLocalDate(text: string): string | null {
  const match = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const day = match[1].padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

function parseBand(value: string): StoreHealthBand | null {
  const match = value.match(/\b(Healthy|Watch|Critical)\b/i);
  if (!match) return null;
  const band = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return band as StoreHealthBand;
}

function parseStatus(value: string): StoreHealthMetricStatus | null {
  const cleaned = value.trim();
  if (/^not\s*scored$/i.test(cleaned)) return "Not scored";
  if (/^green$/i.test(cleaned)) return "Green";
  if (/^amber$/i.test(cleaned)) return "Amber";
  if (/^red$/i.test(cleaned)) return "Red";
  return null;
}

function parseNumberToken(value: string): number | null {
  const match = value.match(/-?[\d,]+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function actualNumber(actualText: string, status: StoreHealthMetricStatus): number | null {
  if (status === "Not scored" || /^no data$/i.test(actualText.trim())) return null;
  const percent = actualText.match(/(-?[\d,]+(?:\.\d+)?)\s*%/);
  if (percent) {
    const value = Number(percent[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value / 100 : null;
  }
  const seconds = actualText.match(/(-?[\d,]+(?:\.\d+)?)\s*s\b/i);
  if (seconds) {
    const value = Number(seconds[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }
  const units = actualText.match(/(-?[\d,]+(?:\.\d+)?)\s*units?\b/i);
  if (units) {
    const value = Number(units[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }
  return parseNumberToken(actualText);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop PDF scraps that are not readable store/network notes. */
export function usableStoreHealthInsight(value: string | null | undefined): string | undefined {
  const text = normalizeSpace(String(value ?? ""));
  if (text.length < 24) return undefined;
  if (/^\{[^}]+\}\.?$/.test(text)) return undefined;
  if (/^from\s+\d+/i.test(text) && text.length < 48) return undefined;
  return text;
}

function extractInsight(text: string, heading: RegExp): string | undefined {
  const match = text.match(heading);
  if (!match || match.index == null) return undefined;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/\b(This store|Metric|TOTAL|Where the points|SPEED & PRODUCTIVITY|All stores)\b/i);
  const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
  return usableStoreHealthInsight(body ? normalizeSpace(body) : undefined);
}

const KNOWN_METRIC_TARGETS = [
  "30 s", "20/30 s", "95%", "0", "98.5%", "<1.5%", "100%", "<=2%", "TBC", "Pass", "85%+"
] as const;

/** Reject insight/wrap lines that end like a metric but are narrative (e.g. "PPI … Red 10 0 days"). */
function isPlausibleMetricActual(actualText: string): boolean {
  const text = actualText.trim();
  if (!text) return false;
  if (/^no data$/i.test(text)) return true;
  if (/^(pass|fail(?:ed)?)\b/i.test(text)) return true;
  // "15 / 15", "34 of 171", "1 of 2"
  if (/^\d[\d,]*\s*(?:\/|of)\s*\d/i.test(text)) return true;
  // Seconds, percents, plain counts, or "16.4 (18 on 1,099 orders)"
  if (/-?[\d,]+(?:\.\d+)?/.test(text)) return true;
  return false;
}

function parseMetricLine(line: string, definition: StoreHealthMetricDefinition): StoreHealthMetricValue | null {
  const normalized = line.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  if (!new RegExp(`^${escapeRegExp(definition.label)}\\b`, "i").test(normalized)) return null;
  // Metric table rows end with status + weight + points. Insight wraps do not.
  const statusMatch = normalized.match(/\b(Green|Amber|Red|Not scored)\s+(\d+(?:\.\d+)?)\s+(-|\d+(?:\.\d+)?)\s*$/i);
  if (!statusMatch || statusMatch.index == null) return null;
  const status = parseStatus(statusMatch[1]) ?? "Not scored";
  const weight = Number(statusMatch[2]);
  const points = statusMatch[3] === "-" ? null : Number(statusMatch[3]);
  const middle = normalized.slice(definition.label.length, statusMatch.index).trim();
  // Require a known target after the label so network notes cannot masquerade as rows.
  const knownTargets = [definition.targetText, ...KNOWN_METRIC_TARGETS];
  let actualText = "";
  let targetText = definition.targetText;
  let matchedTarget = false;
  // Longer targets first so "20/30 s" wins over "30 s" / "0".
  const targetsByLength = [...new Set(knownTargets)].sort((left, right) => right.length - left.length);
  for (const target of targetsByLength) {
    const pattern = new RegExp(`^${escapeRegExp(target)}\\s+(.+)$`, "i");
    const match = middle.match(pattern);
    if (match) {
      targetText = target;
      actualText = match[1].trim();
      matchedTarget = true;
      break;
    }
  }
  if (!matchedTarget || !isPlausibleMetricActual(actualText)) return null;
  // Collapse parenthetical notes that were split as separate cells: "16.4 (18 on 1,099 orders)"
  actualText = actualText.replace(/\s+\(/g, " (").replace(/\s+\)/g, ")");
  const scored = status !== "Not scored";
  return {
    actual_text: actualText,
    actual_number: scored ? actualNumber(actualText, status) : null,
    target_text: targetText,
    status,
    weight: Number.isFinite(weight) ? weight : definition.weight,
    points: scored && points != null && Number.isFinite(points) ? points : null,
    scored
  };
}

/**
 * Prefer a real metric table row when insight/network copy wraps onto a line that
 * also starts with a short label (e.g. "PPI 29.2 s (network), …").
 * Exported for regression tests of wrap/collision cases.
 */
export function findStoreHealthMetricValue(
  lines: string[],
  definition: StoreHealthMetricDefinition
): StoreHealthMetricValue | null {
  const labelPattern = new RegExp(`^${escapeRegExp(definition.label)}\\b`, "i");
  let fallback: StoreHealthMetricValue | null = null;
  for (const entry of lines) {
    const normalized = entry.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    if (!labelPattern.test(normalized)) continue;
    const value = parseMetricLine(normalized, definition);
    if (!value) continue;
    // Exact catalog weight is the table row; keep scanning so a later table row wins
    // over an earlier coincidental parse (should be rare after target/actual checks).
    if (value.weight === definition.weight) return value;
    fallback ??= value;
  }
  return fallback;
}

function parseStorePage(pageText: string, pageNumber: number, _performanceDate: string): StoreHealthStoreRow | null {
  const lines = pageText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const text = normalizeSpace(pageText);
  if (!/store health scorecard/i.test(text) || !/\bTOTAL\b/i.test(text)) return null;
  if (/metric by store/i.test(text) && /points earned\s*\/\s*available/i.test(text)) return null;

  // Prefer the header line "TCC3 • Chennai" / "TCC3 | Chennai" — never a year token.
  let stationCode = "";
  let city: string | null = null;
  for (const line of lines.slice(0, 12)) {
    const match = line.replace(/\|/g, " ").match(/\b([A-Z]{2}[A-Z0-9]{2})\b(?:\s*[•·|]\s*|\s+)([A-Za-z][A-Za-z .'-]{1,40})\b/);
    if (!match) continue;
    const code = normalizeStation(match[1]);
    if (!/^[A-Z]{2}[A-Z0-9]{2}$/.test(code)) continue;
    stationCode = code;
    city = clean(match[2]).replace(/\s+(Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Monday)\b.*/i, "").trim() || null;
    break;
  }
  if (!stationCode) return null;

  const availableMatch = text.match(/(\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+points available/i);
  const totalMatch = text.match(/\bTOTAL\b[^\d]*(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/i);
  const pointsAvailable = Number(availableMatch?.[2] ?? totalMatch?.[1] ?? NaN);
  const pointsEarned = Number(availableMatch?.[1] ?? totalMatch?.[2] ?? NaN);
  if (!Number.isFinite(pointsAvailable) || !Number.isFinite(pointsEarned)) return null;

  // Score % and band are often on separate lines under the store header.
  let scorePct: number | null = null;
  let band: StoreHealthBand | null = null;
  const headerSlice = lines.slice(0, 20).join("\n");
  const headerScore = headerSlice.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (headerScore) scorePct = Math.round(Number(headerScore[1]));
  band = parseBand(headerSlice);
  if (scorePct == null) {
    const formula = text.match(/×\s*100\s*=\s*(\d+(?:\.\d+)?)\s*%/i) ?? text.match(/=\s*(\d+(?:\.\d+)?)\s*%/);
    if (formula) scorePct = Math.round(Number(formula[1]));
  }
  if (scorePct == null && Number.isFinite(pointsAvailable) && pointsAvailable > 0) {
    scorePct = Math.round((pointsEarned / pointsAvailable) * 100);
  }
  if (scorePct == null) return null;
  band ??= scorePct >= 75 ? "Healthy" : scorePct >= 50 ? "Watch" : "Critical";

  const metrics: Record<string, StoreHealthMetricValue> = {};
  for (const definition of storeHealthMetricDefinitions) {
    const value = findStoreHealthMetricValue(lines, definition);
    if (value) metrics[definition.key] = value;
  }
  if (Object.keys(metrics).length < 8) return null;

  return {
    stationCode,
    city,
    scorePct,
    band,
    pointsEarned,
    pointsAvailable,
    insights: {
      network: extractInsight(pageText, /\bAll stores\b/i),
      store: extractInsight(pageText, /\bThis store\b/i)
    },
    metrics,
    pageNumber,
    rawText: text.slice(0, 500)
  };
}

export function storeHealthValuesJson(store: StoreHealthStoreRow, performanceDate: string) {
  return {
    format_version: STORE_HEALTH_FORMAT_VERSION,
    performance_date: performanceDate,
    city: store.city,
    score_pct: store.scorePct,
    band: store.band,
    points_earned: store.pointsEarned,
    points_available: store.pointsAvailable,
    insights: store.insights,
    metrics: store.metrics
  };
}

export function storeHealthBandTone(band: StoreHealthBand | string | null | undefined) {
  if (band === "Healthy") return "green";
  if (band === "Watch") return "amber";
  if (band === "Critical") return "red";
  return "neutral";
}

export function storeHealthStatusSeverity(status: StoreHealthMetricStatus | string | null | undefined): "green" | "amber" | "red" | "neutral" {
  if (status === "Green") return "green";
  if (status === "Amber") return "amber";
  if (status === "Red") return "red";
  return "neutral";
}

export function readStoreHealthFact(values: unknown): {
  scorePct: number | null;
  band: StoreHealthBand | null;
  pointsEarned: number | null;
  pointsAvailable: number | null;
  city: string | null;
  insights: { network?: string; store?: string };
  metrics: Record<string, StoreHealthMetricValue>;
} {
  const json = values && typeof values === "object" && !Array.isArray(values) ? values as Record<string, unknown> : {};
  const metricsRaw = json.metrics && typeof json.metrics === "object" && !Array.isArray(json.metrics)
    ? json.metrics as Record<string, StoreHealthMetricValue>
    : {};
  return {
    scorePct: typeof json.score_pct === "number" ? json.score_pct : null,
    band: typeof json.band === "string" ? json.band as StoreHealthBand : null,
    pointsEarned: typeof json.points_earned === "number" ? json.points_earned : null,
    pointsAvailable: typeof json.points_available === "number" ? json.points_available : null,
    city: typeof json.city === "string" ? json.city : null,
    insights: (json.insights && typeof json.insights === "object" ? json.insights : {}) as { network?: string; store?: string },
    metrics: metricsRaw
  };
}

/** Label lookup for RCA display. */
export function storeHealthMetricLabel(key: string) {
  return LABEL_BY_KEY.get(key) ?? key;
}

/** PDF category order for Store Health scorecard grouping. */
export const storeHealthCategoryOrder = [
  ...new Set(storeHealthMetricDefinitions.map((metric) => metric.category))
];

export function storeHealthCategoryLabel(category: string) {
  return category
    .toLowerCase()
    .split(" ")
    .map((part) => (part === "&" ? "&" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

export function storeHealthMetricCategory(key: string) {
  return storeHealthMetricDefinitions.find((metric) => metric.key === key)?.category ?? "Other";
}

export type StoreHealthReviewMetric = {
  actual: number | null;
  direction: "higher" | "lower";
  key: string;
  label: string;
  severity: "green" | "amber" | "red" | "neutral";
  short: string;
  target: number | null;
  evidence?: string;
  category?: string;
};

export type StoreHealthHero = {
  scorePct: number | null;
  band: StoreHealthBand | null;
  pointsEarned: number | null;
  pointsAvailable: number | null;
  city: string | null;
  networkInsight?: string;
  storeInsight?: string;
};

export function buildStoreHealthReviewMetrics(valuesJson: unknown): {
  metrics: StoreHealthReviewMetric[];
  hero: StoreHealthHero;
} {
  const fact = readStoreHealthFact(valuesJson);
  const metrics: StoreHealthReviewMetric[] = storeHealthMetricDefinitions.map((definition) => {
    const value = fact.metrics[definition.key];
    const severity = value ? storeHealthStatusSeverity(value.status) : "neutral";
    return {
      actual: value?.actual_number ?? null,
      direction: definition.direction,
      key: definition.key,
      label: definition.label,
      severity,
      short: definition.short,
      target: null,
      evidence: value?.actual_text || (severity === "neutral" ? "No data" : undefined),
      category: definition.category
    };
  });
  return {
    metrics,
    hero: {
      scorePct: fact.scorePct,
      band: fact.band,
      pointsEarned: fact.pointsEarned,
      pointsAvailable: fact.pointsAvailable,
      city: fact.city,
      networkInsight: usableStoreHealthInsight(fact.insights.network),
      storeInsight: usableStoreHealthInsight(fact.insights.store)
    }
  };
}

export async function parseStoreHealthScorecardPdf(buffer: ArrayBuffer): Promise<StoreHealthParseResult> {
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pageTexts: string[] = [];
  let fullText = "";
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = (content.items as Array<{ str?: string; transform?: number[] }>)
      .filter((item) => clean(item.str))
      .map((item) => ({ text: clean(item.str), y: Number(item.transform?.[5] ?? 0), x: Number(item.transform?.[4] ?? 0) }))
      .sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x);
    const lines: Array<{ y: number; cells: typeof items }> = [];
    items.forEach((item) => {
      const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
      if (line) line.cells.push(item);
      else lines.push({ y: item.y, cells: [item] });
    });
    const pageText = lines
      .map((line) => line.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" "))
      .join("\n");
    pageTexts.push(pageText);
    fullText += `${pageText}\n`;
  }

  const performanceDate = parseLocalDate(fullText);
  if (!performanceDate) throw new Error("Could not read the performance date from the Store Health Scorecard PDF.");

  const versionMatch = fullText.match(/Store Health Metrics\s*(v?\d+(?:\.\d+)?)/i);
  const stores: StoreHealthStoreRow[] = [];
  const seen = new Set<string>();
  pageTexts.forEach((pageText, index) => {
    const store = parseStorePage(pageText, index + 1, performanceDate);
    if (!store || seen.has(store.stationCode)) return;
    seen.add(store.stationCode);
    stores.push(store);
  });

  if (!stores.length) {
    throw new Error("No store detail pages were found in the Store Health Scorecard PDF.");
  }

  return {
    performanceDate,
    stores,
    metricsVersion: versionMatch?.[1] ?? null
  };
}

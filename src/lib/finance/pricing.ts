export const amazonFields = [
  ["delivery_mg_volume", "Delivery MG_Volume"],
  ["ihs_mg_volume", "IHS MG_Volume"],
  ["mg_amount_including_mhe", "MG Amount incl MHE"],
  ["mfn_rate", "mfn_rate"],
  ["ihs_rate_below_15_percent", "ihs_rate if < 15%"],
  ["ihs_rate_above_15_percent", "ihs_rate if > 15%"],
  [
    "undeliverable_missorts_damaged_webrejects",
    "undeliverable_missorts_damaged_webrejects",
  ],
  [
    "mg_shortfall_recovery_per_shipment",
    "Recovery per shipment in case of MG volume shortfall",
  ],
  ["fire_safety_equipment_fee", "Fire Safety equipment fee"],
  ["variable_slab", "Variable_Slab"],
  ["smd_rate", "SMD rate"],
] as const;
export type Slab = { above: string; upto: string | null; rate: string };
export type PricingInput = {
  provider: "Amazon" | "Flipkart";
  station_code: string;
  effective_month: string;
  expected_revision: number;
  rates: Record<string, string | null>;
  slabs: Slab[];
  slab_mode: "progressive" | "all_units";
  reason: string;
  source_file?: string | null;
  source_sha256?: string | null;
};
export type PricingCard = Omit<PricingInput, "expected_revision"> & {
  id: string;
  revision: number;
  created_at: string;
};
export function todayIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function validMonth(month: string) {
  return /^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
}
export function monthEnd(month: string) {
  if (!validMonth(month)) throw new Error("Choose a valid billing month.");
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
}
const scale = BigInt(10) ** BigInt(24);
// Exact decimal arithmetic until the final paise rounding; source values remain strings.
export function decimal(value: string): bigint {
  if (!/^-?\d{1,16}(\.\d{1,24})?$/.test(value))
    throw new Error("Invalid decimal amount.");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(24, "0"));
  return negative ? -result : result;
}
export function amount(value: bigint) {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const cents = (absolute * BigInt(100) + scale / BigInt(2)) / scale;
  return `${negative && cents ? "-" : ""}${cents / BigInt(100)}.${String(cents % BigInt(100)).padStart(2, "0")}`;
}
export function addAmounts(values: Array<string | null>) {
  const present = values.filter((v): v is string => v !== null);
  return present.length
    ? amount(present.reduce((sum, v) => sum + decimal(v), BigInt(0)))
    : null;
}
export function subtractAmounts(a: string, b: string) {
  return amount(decimal(a) - decimal(b));
}
export function mgEstimate(
  monthly: string,
  elapsedDays: number,
  monthDays: number,
) {
  return amount((decimal(monthly) * BigInt(elapsedDays)) / BigInt(monthDays));
}
export function slabEstimate(
  quantity: string,
  slabs: Slab[],
  mode: PricingInput["slab_mode"],
) {
  const qty = decimal(quantity);
  if (qty < BigInt(0)) throw new Error("Delivery quantity cannot be negative.");
  if (qty === BigInt(0)) return "0.00";
  if (mode === "all_units") {
    const band = slabs.find(
      (s) =>
        qty > decimal(s.above) && (s.upto === null || qty <= decimal(s.upto)),
    );
    if (!band) return null;
    return amount((qty * decimal(band.rate)) / scale);
  }
  let total = BigInt(0);
  for (const band of slabs) {
    const upper =
      band.upto === null
        ? qty
        : qty < decimal(band.upto)
          ? qty
          : decimal(band.upto);
    const units = upper - decimal(band.above);
    if (units > BigInt(0)) total += (units * decimal(band.rate)) / scale;
  }
  return amount(total);
}
function numeric(
  value: unknown,
  label: string,
  required = false,
): string | null {
  if (value == null || value === "") {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string")
    throw new Error(`${label} must be supplied as decimal text.`);
  const text = value.trim();
  if (!/^\d{1,16}(\.\d{1,24})?$/.test(text))
    throw new Error(
      `${label} must be a non-negative number (up to 24 decimal places).`,
    );
  return text;
}
export function validatePricing(value: unknown): PricingInput {
  if (!value || typeof value !== "object")
    throw new Error("Invalid pricing record.");
  const v = value as PricingInput;
  if (!["Amazon", "Flipkart"].includes(v.provider))
    throw new Error("Choose Amazon or Flipkart.");
  if (
    typeof v.station_code !== "string" ||
    !/^[A-Z0-9_-]{1,40}$/.test(v.station_code)
  )
    throw new Error("Choose a valid station code.");
  if (
    typeof v.effective_month !== "string" ||
    !validMonth(v.effective_month.slice(0, 7)) ||
    v.effective_month !== `${v.effective_month.slice(0, 7)}-01`
  )
    throw new Error("Choose an effective month.");
  if (!Number.isSafeInteger(v.expected_revision) || v.expected_revision < 0)
    throw new Error("Invalid revision.");
  if (typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 500)
    throw new Error("Add a change reason (up to 500 characters).");
  if (!["progressive", "all_units"].includes(v.slab_mode))
    throw new Error("Choose a slab calculation method.");
  const rates: Record<string, string | null> = {};
  if (v.provider === "Amazon") {
    for (const [key, label] of amazonFields)
      rates[key] = numeric(
        v.rates?.[key],
        label,
        key === "mg_amount_including_mhe" || key === "delivery_mg_volume",
      );
    for (const key of ["city", "state", "partner", "sp_name"]) {
      const text = v.rates?.[key];
      if (text != null && (typeof text !== "string" || text.length > 250))
        throw new Error(`Invalid ${key}.`);
      rates[key] = text ?? null;
    }
  }
  let slabs: Slab[] = [];
  if (v.provider === "Flipkart") {
    if (!Array.isArray(v.slabs) || !v.slabs.length || v.slabs.length > 100)
      throw new Error("Add between 1 and 100 delivery slabs.");
    slabs = v.slabs.map((s, i) => ({
      above: numeric(s.above, `Slab ${i + 1} lower bound`, true)!,
      upto: numeric(s.upto, `Slab ${i + 1} upper bound`),
      rate: numeric(s.rate, `Slab ${i + 1} rate`, true)!,
    }));
    let previous = BigInt(0);
    slabs.forEach((s, i) => {
      if (
        decimal(s.above) !== previous ||
        (s.upto !== null && decimal(s.upto) <= previous)
      )
        throw new Error(
          "Slabs must start at 0 and be contiguous, increasing and non-overlapping.",
        );
      if ((s.upto === null) !== (i === slabs.length - 1))
        throw new Error(
          "Only the final slab must have an empty upper bound (unlimited).",
        );
      if (s.upto) previous = decimal(s.upto);
    });
  }
  if (
    v.source_file != null &&
    (typeof v.source_file !== "string" || v.source_file.length > 250)
  )
    throw new Error("Invalid source filename.");
  if (v.source_sha256 != null && !/^[a-f0-9]{64}$/.test(v.source_sha256))
    throw new Error("Invalid source checksum.");
  return {
    provider: v.provider,
    station_code: v.station_code,
    effective_month: v.effective_month,
    expected_revision: v.expected_revision,
    rates,
    slabs,
    slab_mode: v.slab_mode,
    reason: v.reason.trim(),
    source_file: v.source_file ?? null,
    source_sha256: v.source_sha256 ?? null,
  };
}
// RFC 4180 CSV, preserving decimal strings, quoted commas and newlines.
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const text = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("Malformed CSV quote.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed) throw new Error("Malformed CSV after quoted field.");
      field += c;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}
export function amazonCsv(
  source: string,
  month: string,
  filename: string,
  hash: string,
): PricingInput[] {
  const [headers, ...rows] = parseCsv(source);
  if (!headers || !rows.length || rows.length > 500)
    throw new Error("CSV must contain 1 to 500 stations.");
  const normalized = headers.map((s) => s.trim());
  if (new Set(normalized).size !== normalized.length)
    throw new Error("Duplicate CSV headers.");
  for (const key of ["station_code", ...amazonFields.map((f) => f[1])])
    if (!normalized.includes(key))
      throw new Error(`Missing CSV column: ${key}`);
  const seen = new Set<string>();
  return rows.map((cells, index) => {
    if (cells.length !== headers.length)
      throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const record = Object.fromEntries(
      normalized.map((key, i) => [key, cells[i].trim()]),
    );
    const station_code = record.station_code.toUpperCase();
    if (seen.has(station_code))
      throw new Error(`Duplicate station ${station_code}.`);
    seen.add(station_code);
    const rates = Object.fromEntries(
      amazonFields.map(([key, label]) => [key, record[label] || null]),
    );
    for (const key of ["city", "state", "partner", "sp_name"])
      rates[key] = record[key] || null;
    return validatePricing({
      provider: "Amazon",
      station_code,
      effective_month: `${month}-01`,
      expected_revision: 0,
      rates,
      slabs: [],
      slab_mode: "progressive",
      reason: `Imported Amazon MG for ${month}`,
      source_file: filename,
      source_sha256: hash,
    });
  });
}
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+@\-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function csvText(rows: unknown[][]) {
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

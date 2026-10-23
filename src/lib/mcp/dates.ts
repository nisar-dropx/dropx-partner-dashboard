const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!ISO_DATE.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return text;
}

export function indiaDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

export function parseStationCodes(value: unknown): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return Array.from(
    new Set(
      list
        .map((item) => String(item ?? "").trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

/** Intersect requested station codes with a permitted set (case-insensitive). */
export function intersectStationCodes(permitted: string[], requested: string[]): {
  allowed: string[];
  missing: string[];
} {
  const permittedSet = new Set(permitted.map((code) => code.toUpperCase()));
  if (!requested.length) {
    return { allowed: [...permittedSet], missing: [] };
  }
  const allowed: string[] = [];
  const missing: string[] = [];
  for (const code of requested) {
    const upper = code.toUpperCase();
    if (permittedSet.has(upper)) allowed.push(upper);
    else missing.push(upper);
  }
  return { allowed, missing };
}

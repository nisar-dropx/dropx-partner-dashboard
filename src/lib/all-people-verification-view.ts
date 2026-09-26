import type { AllPeopleExportKey } from "@/lib/all-people-export";

export type VerificationViewTone = "success" | "warning" | "error" | "neutral";

export type AllPeopleVerificationSummary = {
  text: string;
  tone: VerificationViewTone;
};

export type VerificationSummarySource = {
  kind: string;
  verified?: boolean | null;
  manualReview?: boolean | null;
  manual_review?: boolean | null;
  message?: unknown;
  warning?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  name?: unknown;
  accountName?: unknown;
  ownerName?: unknown;
  fuelType?: unknown;
  nameMatchStatus?: unknown;
  details?: Record<string, unknown> | null;
};

export type ColumnVerificationSummary = {
  column: AllPeopleExportKey;
  summary: AllPeopleVerificationSummary;
};

export const vehicleExpiryFieldKeys = new Set<AllPeopleExportKey>([
  "vehicleRegistrationExpiry",
  "vehicleInsuranceExpiry",
  "pollutionExpiry"
]);

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function sourceValue(source: VerificationSummarySource, key: string) {
  const direct = clean((source as unknown as Record<string, unknown>)[key]);
  if (direct) return direct;
  return clean(source.details?.[key]);
}

function holderName(source: VerificationSummarySource, key: "name" | "accountName" | "ownerName") {
  return sourceValue(source, key) || clean(source.displayName) || clean(source.display_name);
}

function nameTone(source: VerificationSummarySource): VerificationViewTone {
  const matchStatus = sourceValue(source, "nameMatchStatus").toLowerCase();
  if (matchStatus === "exact") return "success";
  if (matchStatus === "partial") return "warning";
  if (matchStatus === "none") return "error";
  if (source.verified === true) return "success";
  if (source.manualReview === true || source.manual_review === true) return "warning";
  return "error";
}

export function buildVerificationViewSummary(source: VerificationSummarySource): ColumnVerificationSummary | null {
  const storedMessage = clean(source.message) || sourceValue(source, "message") || sourceValue(source, "warning");
  if (source.details?.invalidated === true || storedMessage.toLowerCase() === "reverification required after profile field update.") return null;

  if (source.kind === "pan") {
    const name = holderName(source, "name");
    return name ? { column: "panNumber", summary: { text: `Holder name: ${name}`, tone: nameTone(source) } } : null;
  }

  if (source.kind === "pan_aadhaar") {
    return storedMessage ? { column: "aadhaarNumber", summary: { text: storedMessage, tone: source.verified === true ? "success" : "error" } } : null;
  }

  if (source.kind === "bank") {
    const name = holderName(source, "accountName");
    return name ? { column: "bankAccountNumber", summary: { text: `Holder name: ${name}`, tone: "neutral" } } : null;
  }

  if (source.kind === "pf_uan") {
    const name = holderName(source, "name");
    return name ? { column: "pfUan", summary: { text: `Holder name: ${name}`, tone: nameTone(source) } } : null;
  }

  if (source.kind === "dl") {
    const name = holderName(source, "name");
    return name ? { column: "drivingLicenseNumber", summary: { text: `Holder name: ${name}`, tone: nameTone(source) } } : null;
  }

  if (source.kind === "vehicle") {
    const ownerName = holderName(source, "ownerName");
    const fuelType = sourceValue(source, "fuelType");
    const details = [ownerName ? `RC owner: ${ownerName}` : "", fuelType ? `Fuel type: ${fuelType}` : ""].filter(Boolean);
    return details.length ? { column: "vehicleRegistrationNumber", summary: { text: details.join(" · "), tone: "neutral" } } : null;
  }

  return null;
}

function dateParts(value: string) {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const display = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  return display ? { year: Number(display[3]), month: Number(display[2]), day: Number(display[1]) } : null;
}

export function peopleDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function isExpiredPeopleDate(value: string, today: string | Date = peopleDateKey()) {
  const parts = dateParts(value);
  const todayParts = dateParts(typeof today === "string" ? today : peopleDateKey(today));
  if (!parts || !todayParts) return false;
  const candidate = new Date(parts.year, parts.month - 1, parts.day);
  if (
    candidate.getFullYear() !== parts.year ||
    candidate.getMonth() !== parts.month - 1 ||
    candidate.getDate() !== parts.day
  ) return false;
  const expiryKey = parts.year * 10_000 + parts.month * 100 + parts.day;
  const todayKey = todayParts.year * 10_000 + todayParts.month * 100 + todayParts.day;
  return expiryKey < todayKey;
}

const dashboardTimeZone = "Asia/Kolkata";

export function dashboardDateInputValue(value: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: dashboardTimeZone
  }).format(value);
}

function dateOnlyParts(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { day: match[3], month: match[2], year: match[1] };
}

export function formatDashboardDate(
  value: string | Date | null | undefined,
  fallback = "-"
) {
  if (!value) return fallback;

  if (typeof value === "string") {
    const parts = dateOnlyParts(value);
    if (parts) return `${parts.day}/${parts.month}/${parts.year}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: dashboardTimeZone
  }).format(date);
}

export function formatDashboardDateTime(
  value: string | Date | null | undefined,
  fallback = "-"
) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: dashboardTimeZone
  }).format(date);
}

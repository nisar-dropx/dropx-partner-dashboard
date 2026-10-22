const dashboardTimeZone = "Asia/Kolkata";

// Reuse ICU's formatter: constructing one for every cell in a monthly export
// retains substantial native memory even when the worksheet itself is streamed.
const dashboardDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: dashboardTimeZone
});

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

/** Readable review/context dates, e.g. "20 Oct 2026". */
export function formatDashboardDateMedium(
  value: string | Date | null | undefined,
  fallback = "-"
) {
  if (!value) return fallback;

  if (typeof value === "string") {
    const parts = dateOnlyParts(value);
    if (parts) {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const month = months[Number(parts.month) - 1];
      if (month) return `${Number(parts.day)} ${month} ${parts.year}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
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
  return dashboardDateTimeFormatter.format(date);
}

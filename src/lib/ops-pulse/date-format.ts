import { formatDashboardDateMedium } from "@/lib/date-format";

const opsTimeZone = "Asia/Kolkata";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateOnlyParts(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3] };
}

/** Ops Pulse display dates, e.g. "23 Oct 2026". Does not change partner-wide formatDashboardDate. */
export function formatOpsDate(
  value: string | Date | null | undefined,
  fallback = "-"
) {
  return formatDashboardDateMedium(value, fallback);
}

/** Ops Pulse date+time, e.g. "23 Oct 2026, 12:42 pm". */
export function formatOpsDateTime(
  value: string | Date | null | undefined,
  fallback = "-"
) {
  if (!value) return fallback;

  if (typeof value === "string") {
    const parts = dateOnlyParts(value);
    if (parts) {
      const month = months[Number(parts.month) - 1];
      if (month) return `${Number(parts.day)} ${month} ${parts.year}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;

  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: opsTimeZone
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: opsTimeZone
  }).format(date);
  return `${dateLabel}, ${timeLabel}`;
}

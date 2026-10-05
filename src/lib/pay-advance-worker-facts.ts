export function indiaMonthStart(value: string | null) {
  const date = value ? new Date(value) : new Date();
  const when = Number.isNaN(date.getTime()) ? new Date() : date;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
  return `${day.slice(0, 7)}-01`;
}

export function monthEnd(monthStart: string) {
  const [year, month] = monthStart.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthStart.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

/** Present and partial-day rows count as time worked. Half days count as half. */
export function workingDaysFromStatuses(statuses: string[]) {
  return statuses.reduce((sum, status) => {
    const code = status.trim().toUpperCase();
    if (code === "P" || code === "PD") return sum + 1;
    if (code === "HD") return sum + 0.5;
    return sum;
  }, 0);
}

export function formatApplyingMonth(monthStart: string) {
  const [year, month] = monthStart.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function workerCodeFromDetails(details: unknown) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const code = (details as { worker_code?: unknown }).worker_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

export function formatWorkingDays(days: number) {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

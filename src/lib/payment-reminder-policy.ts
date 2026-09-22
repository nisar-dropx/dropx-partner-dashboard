export type PaymentWorkHours = { timezone: string; start: string; end: string; days: number[] };
export const defaultPaymentWorkHours: PaymentWorkHours = { timezone: "Asia/Kolkata", start: "09:00", end: "18:00", days: [0,1,2,3,4,5,6] };

export function validatePaymentWorkHours(value: PaymentWorkHours) {
  new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end) || value.start >= value.end)
    throw new Error("Work hours must be a valid start/end time within one day.");
  if (!value.days.length || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Select at least one work day.");
  return value;
}
export function withinPaymentWorkHours(now: Date, hours: PaymentWorkHours) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: hours.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday"));
  const time = `${get("hour")}:${get("minute")}`;
  return hours.days.includes(day) && time >= hours.start && time < hours.end;
}
export function nextPaymentReminder(now: Date, interval: number, hours: PaymentWorkHours) {
  let candidate = new Date(now.getTime() + interval * 60_000);
  // Wall-clock interval, deferred to opening time if it falls outside work hours.
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (withinPaymentWorkHours(candidate, hours)) return candidate.toISOString();
    candidate = new Date(Math.floor(candidate.getTime() / 60_000) * 60_000 + 60_000);
  }
  throw new Error("Unable to find next payment reminder working window.");
}
export function paymentThreadMonth(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}-01`;
}

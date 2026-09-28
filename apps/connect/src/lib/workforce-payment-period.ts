export function workforcePaymentPeriod(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a valid month.");
  const [year, number] = month.split("-").map(Number);
  const from = `${month}-01`;
  const next = new Date(Date.UTC(year, number, 1));
  return {from,to:next.toISOString().slice(0,10),label:new Intl.DateTimeFormat("en-IN",{month:"long",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${from}T00:00:00+05:30`))};
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Inclusive-through-today reads expressed as an exclusive upper bound. */
export function workforcePaymentReadPeriod(month: string, today: string) {
  const period = workforcePaymentPeriod(month);
  if (!validDate(today)) throw new Error("Choose a valid payment date.");
  const currentMonth = today.slice(0, 7);
  if (month > currentMonth) throw new Error("Choose the current month or an earlier month.");
  if (month < currentMonth) return period;
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { ...period, to: tomorrow.toISOString().slice(0, 10) };
}

export function workforcePaymentMonth(now = new Date()) {
  const month = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(now);
  return workforcePaymentPeriod(month);
}

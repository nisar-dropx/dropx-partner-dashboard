export function workforcePaymentMonth(now = new Date()) {
  const month = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(now);
  const [year, number] = month.split("-").map(Number);
  const from = `${month}-01`;
  const next = new Date(Date.UTC(year, number, 1));
  return {from,to:next.toISOString().slice(0,10),label:new Intl.DateTimeFormat("en-IN",{month:"long",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${from}T00:00:00+05:30`))};
}

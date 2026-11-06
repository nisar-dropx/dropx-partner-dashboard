const hourly = Array.from({ length: 14 }, (_, i) => String(i + 8).padStart(2, "0") + ":00");
export const dispatchReports = {
  edd: "EDD pendency", station: "At station", dsr: "DSR", creturn: "C-Return", ageing: "Ageing",
  zero: "Zero-delivery DAs", scrub: "Scrub", cod: "COD", recon: "DA reconciliation",
  deposit: "Prepare deposit", bank: "Bank remittance", slip: "COD slip"
};
export type ReportKey = keyof typeof dispatchReports;
export function suggestedTimes(key: ReportKey) {
  if (key === "ageing") return ["10:00", "17:00"];
  if (key === "zero") return hourly.filter(time => time > "12:00");
  return ["edd", "station", "dsr", "creturn"].includes(key) ? hourly : [];
}
export function parseSlots(raw: string, key: ReportKey) {
  const times = [...new Set(raw.split(",").map(x => x.trim()))].sort();
  if (times.length > 24 || times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error("Enter up to 24 times in HH:MM, separated by commas.");
  if (key === "zero" && times.some(time => time <= "12:00")) throw new Error("Choose times after noon for zero deliveries.");
  return times;
}

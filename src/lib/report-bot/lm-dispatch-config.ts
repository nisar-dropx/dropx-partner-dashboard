export const dispatchReports = {
  edd: "EDD pendency", station: "At station", dsr: "DSR", creturn: "C-Return", ageing: "Ageing",
  zero: "Zero-delivery DAs", scrub: "Scrub", cod: "COD", recon: "DA reconciliation",
  deposit: "Prepare deposit", bank: "Bank remittance", slip: "COD slip",
  eod: "Final EOD · DSR + DOT + C-Return"
};
export type ReportKey = keyof typeof dispatchReports;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clockMinutes(value: string) {
  const match = CLOCK.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

export function scheduleSlots(start: string, end: string, intervalMinutes: number) {
  const first = clockMinutes(start), last = clockMinutes(end);
  if (!Number.isInteger(first) || !Number.isInteger(last)) throw new Error("Choose valid start and end times.");
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 720) throw new Error("Interval must be between 5 and 720 minutes.");
  if (last < first) throw new Error("End time must be after the start time on the same day.");
  const slots: string[] = [];
  for (let minute = first; minute <= last; minute += intervalMinutes) {
    slots.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
  }
  if (!slots.length || slots.length > 96) throw new Error("This window creates too many send slots. Increase the interval.");
  return slots;
}

export function suggestedTimes(key: ReportKey) {
  if (key === "eod") return ["23:30"];
  if (key === "ageing") return ["10:00", "17:00"];
  if (key === "zero") return scheduleSlots("13:00", "21:00", 60);
  return ["edd", "station", "dsr", "creturn"].includes(key) ? scheduleSlots("08:00", "21:00", 60) : [];
}
export function parseSlots(raw: string, key: ReportKey) {
  const times = [...new Set(raw.split(",").map(x => x.trim()))].sort();
  if (!times.length || times.length > 96 || times.some(time => !CLOCK.test(time))) throw new Error("Enter between 1 and 96 times in HH:MM, separated by commas.");
  if (key === "zero" && times.some(time => time <= "12:00")) throw new Error("Choose times after noon for zero deliveries.");
  return times;
}

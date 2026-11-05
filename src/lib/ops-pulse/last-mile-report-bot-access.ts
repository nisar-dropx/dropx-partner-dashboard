/** Joseph-only preview access for Last Mile Report Bot (nav, pages, station-board flash). */
const LAST_MILE_REPORT_BOT_ALLOWLIST = new Set([
  "tech@dropxlogistics.com",
  "josephmathew072@gmail.com",
]);

export function canAccessLastMileReportBot(email: string | null | undefined) {
  return LAST_MILE_REPORT_BOT_ALLOWLIST.has(String(email ?? "").trim().toLowerCase());
}

/** Same allowlist: Live performance WhatsApp → Report Bot flash. */
export function canFlashStationBoardReportBot(email: string | null | undefined) {
  return canAccessLastMileReportBot(email);
}

/** Joseph-only preview of Report Bot flash on Live performance (pure, client-safe). */
const FLASH_ALLOWLIST = new Set(["tech@dropxlogistics.com", "josephmathew072@gmail.com"]);

export function canFlashStationBoardReportBot(email: string | null | undefined) {
  return FLASH_ALLOWLIST.has(String(email ?? "").trim().toLowerCase());
}

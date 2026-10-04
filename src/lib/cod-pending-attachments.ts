import type { DigestAttachment } from "./portal-digest-attachments";
import { digestMailAttachments } from "./portal-digest-attachments";
import type { CodPendingRow } from "./ops-pulse/cod-pending";
import type { CodAgeingSnapshot } from "./ops-pulse/cod-ageing";
import type { CodNoUpdateStreak } from "./ops-pulse/cod-no-update-streak";
import { previousReportDate } from "./ops-pulse/cod-no-update-streak";
import { codAgeConcern } from "./ops-pulse/review-cod";

function csv(rows: unknown[][]) {
  const cell = (value: unknown) => {
    const raw = String(value ?? "");
    // Keep imported text literal when the attachment is opened in a spreadsheet.
    return '"' + (/^\s*[=+@-]/.test(raw) ? "'" + raw : raw).replace(/"/g, '""') + '"';
  };
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}

/** The caller supplies only this recipient's permitted report rows. */
export function buildCodPendingAttachments(
  rows: CodPendingRow[], source: CodAgeingSnapshot, streaks: CodNoUpdateStreak[], date: string
): DigestAttachment[] {
  const allowedIds = new Set(rows.map(row => row.station.id));
  const amazonCodes = new Set(rows.filter(row => row.client === "amazon").map(row => row.station.station_code));
  const daysByStation = new Map(streaks.filter(row => allowedIds.has(row.stationId)).map(row => [row.stationId, row.days]));
  // Honour source age bands; unknown labels require dated evidence at the pinned data date.
  const cash = source.error ? [] : source.stations.filter(station => amazonCodes.has(station.stationCode)).map(station => ({
    stationCode: station.stationCode,
    lines: station.lines.filter(line => line.amount > 0 && codAgeConcern(line.bucket, line.pendingDate, source.dataDate + "T12:00:00Z"))
  })).filter(station => station.lines.length);
  const cashByStation = new Map(cash.map(station => [station.stationCode, station.lines.reduce((cents, line) => cents + Math.round(line.amount * 100), 0) / 100]));
  const pending = rows.filter(row => (daysByStation.get(row.station.id) ?? 0) >= 2 || cashByStation.has(row.station.station_code))
    .sort((a, b) => a.station.station_code.localeCompare(b.station.station_code));
  if (!pending.length) return [];
  const attachments: DigestAttachment[] = [];
  const add = (filename: string, data: unknown[][]) => attachments.push({
    filename, contentType: "text/csv; charset=utf-8", encoding: "base64", content: Buffer.from(csv(data), "utf8").toString("base64")
  });
  add(`COD_pendency_2plus_${date}.csv`, [
    ["Report date", "Station", "Station name", "Client", "Reason for inclusion", "Consecutive days without COD update (7+ capped)", "No update since (at least)", "Daily update", "Slip uploaded", "Validation", "Follow-up", "Deposited INR", "Short INR", "Outstanding cash 2+ days INR", "EDSP data as of", "EDSP source status"],
    ...pending.map(row => {
      const days = daysByStation.get(row.station.id) ?? 0;
      const amount = cashByStation.get(row.station.station_code) ?? 0;
      return [date, row.station.station_code, row.station.station_name, row.client,
        [days >= 2 ? "COD update missing for 2+ days" : "", amount > 0 ? "Outstanding cash aged 2+ days" : ""].filter(Boolean).join("; "),
        days >= 7 ? "7+" : days, days ? previousReportDate(date, days - 1) : "", row.status,
        row.slipUploaded ? "Yes" : "No", row.validation, row.validationReason, row.amount, row.short,
        row.client !== "amazon" || source.error ? "" : amount,
        row.client === "amazon" ? source.dataDate : "",
        row.client !== "amazon" ? "Not applicable" : source.error || "Verified"];
    })
  ]);
  if (cash.length) add(`EDSP_outstanding_cash_2plus_${date}.csv`, [
    ["Report date", "Upload date", "Data as of", "Source file", "Batch ID", "Station", "Tracking ID", "Order ID", "Associate", "Associate ID", "Pending since", "Original age band", "Status", "Outstanding INR", "Source row"],
    ...cash.sort((a, b) => a.stationCode.localeCompare(b.stationCode)).flatMap(station => station.lines.map(line => [
      date, source.uploadDate, source.dataDate, source.fileName, source.batchId, station.stationCode,
      line.trackingId, line.orderId, line.associate, line.associateId, line.pendingDate, line.bucket, line.status, line.amount, line.rowNumber
    ]))
  ]);
  digestMailAttachments(attachments);
  return attachments;
}

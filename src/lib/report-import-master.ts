export type ReportImportMaster = {
  id: string;
  source_code: string;
  name: string;
  description: string | null;
  file_types: string[];
  day_offset: number;
  upload_time: string | null;
  frequency: "daily" | "weekly" | "monthly" | "adhoc";
  weekday: number | null;
  parser_type: string;
  dedupe_fields: string[];
  is_active: boolean;
  requires_station: boolean;
  station_scope: "none" | "all" | "amazon_dsp_xpt" | "amazon_dsp_xpd";
  requires_report_date: boolean;
  report_date_label: string | null;
  date_default_offset: number;
};

export const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function reportSchedule(report: ReportImportMaster) {
  const offset = report.day_offset === -2 ? "D-2" : report.day_offset === -1 ? "D-1" : report.day_offset === 0 ? "D0" : `D${report.day_offset > 0 ? "+" : ""}${report.day_offset}`;
  const [hourText, minute = "00"] = (report.upload_time ?? "").split(":");
  const hour = Number(hourText);
  const time = report.upload_time && Number.isFinite(hour)
    ? `${hour % 12 || 12}:${minute} ${hour >= 12 ? "pm" : "am"}`
    : "time not set";
  const cadence = report.frequency === "weekly" && report.weekday !== null
    ? `weekly - every ${weekdayNames[report.weekday]}`
    : report.frequency;
  return `${offset} · ${time} · ${cadence}`;
}

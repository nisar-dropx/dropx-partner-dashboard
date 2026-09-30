export type FleetDailyStatusVehicle = {
  vehicle_no: string;
  station_code: string;
  model: string;
  ownership_type: string | null;
  status: string | null;
  non_operational_since: string | null;
  expected_operational_date: string | null;
  status_comment: string | null;
};

export type FleetDailyStatusSummary = {
  station: string;
  ownTotal: number;
  ownOperational: number;
  ownNonOperational: number;
  partnerTotal: number;
  partnerOperational: number;
  partnerNonOperational: number;
  totalNonOperational: number;
  adHocVans: number;
};

const clean = (value: unknown) => String(value ?? "").trim();
const esc = (value: unknown) => clean(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const owned = (type: unknown) => !["odcd", "rented", "leased"].includes(clean(type).toLowerCase());
const cell = (value: unknown, extra = "") => `<td style="padding:11px 9px;border-bottom:1px solid #e7ebef;text-align:center;color:#273142;${extra}">${esc(value)}</td>`;
const dateLabel = (value: string | null) => {
  if (!value) return "Update required";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00+05:30`);
  return Number.isNaN(parsed.valueOf()) ? clean(value) : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(parsed);
};

function fleetTable(rows: FleetDailyStatusSummary[]) {
  const totals = (key: keyof Omit<FleetDailyStatusSummary, "station">) => rows.reduce((sum, row) => sum + row[key], 0);
  const body = rows.map((row) => {
    const alert = row.totalNonOperational > 0;
    return `<tr style="background:${alert ? "#fff9f5" : "#ffffff"}">${cell(row.station, "font-weight:800;text-align:left;color:#111a2f")}${cell(row.ownTotal)}${cell(row.ownOperational, "color:#167a57;font-weight:700")}${cell(row.ownNonOperational, row.ownNonOperational ? "color:#c52a42;font-weight:800" : "color:#7d8794")}${cell(row.partnerTotal)}${cell(row.partnerOperational, "color:#167a57;font-weight:700")}${cell(row.partnerNonOperational, row.partnerNonOperational ? "color:#c52a42;font-weight:800" : "color:#7d8794")}${cell(row.totalNonOperational, row.totalNonOperational ? "background:#fff0f2;color:#c52a42;font-weight:900" : "color:#7d8794")}${cell(row.adHocVans, row.adHocVans ? "background:#fff6df;color:#9c6300;font-weight:900" : "color:#7d8794")}</tr>`;
  }).join("");
  const totalRow = ["Total", totals("ownTotal"), totals("ownOperational"), totals("ownNonOperational"), totals("partnerTotal"), totals("partnerOperational"), totals("partnerNonOperational"), totals("totalNonOperational"), totals("adHocVans")]
    .map((value, index) => cell(value, `font-weight:900;${index === 0 ? "text-align:left;" : ""}background:#111a2f;color:#ffffff;border-bottom:0`)).join("");
  return `<div style="overflow-x:auto;border:1px solid #dfe4e8;border-radius:14px;background:#ffffff"><table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;min-width:760px;font:12px Arial,sans-serif"><thead><tr><th rowspan="2" style="padding:12px 9px;background:#111a2f;color:#fff;text-align:left;border-radius:13px 0 0 0">Station</th><th colspan="3" style="padding:9px;background:#1f7a70;color:#fff;border-left:1px solid #ffffff33">DropX owned</th><th colspan="3" style="padding:9px;background:#3265a8;color:#fff;border-left:1px solid #ffffff33">ODCD / rented</th><th rowspan="2" style="padding:9px;background:#c52a42;color:#fff;border-left:1px solid #ffffff33">Non-operational</th><th rowspan="2" style="padding:9px;background:#d97818;color:#fff;border-left:1px solid #ffffff33;border-radius:0 13px 0 0">Ad hoc vans</th></tr><tr style="background:#edf1f4;color:#3a4655"><th style="padding:8px">Total</th><th>Operational</th><th>Down</th><th>Total</th><th>Operational</th><th>Down</th></tr></thead><tbody>${body}<tr>${totalRow}</tr></tbody></table></div>`;
}

function exceptionTable(rows: FleetDailyStatusVehicle[]) {
  if (!rows.length) return `<div style="padding:22px;text-align:center;border:1px solid #cfe9df;background:#f0fbf6;border-radius:14px;color:#167a57;font-weight:700">No non-operational vehicles in the selected stations.</div>`;
  const body = rows.map((row) => {
    const status = clean(row.status).replaceAll("_", " ") || "Non-operational";
    return `<tr><td style="padding:12px 10px;border-bottom:1px solid #e7ebef"><strong style="color:#111a2f">${esc(row.vehicle_no)}</strong><br><span style="color:#7d8794;font-size:11px">${esc(row.model)}</span></td><td style="padding:12px 10px;border-bottom:1px solid #e7ebef"><span style="display:inline-block;padding:4px 8px;border-radius:999px;background:#e9f4f1;color:#176b61;font-weight:700">${esc(row.station_code)}</span></td><td style="padding:12px 10px;border-bottom:1px solid #e7ebef;color:#4b5868">${owned(row.ownership_type) ? "DropX owned" : esc(clean(row.ownership_type).toUpperCase())}</td><td style="padding:12px 10px;border-bottom:1px solid #e7ebef"><span style="display:inline-block;padding:4px 8px;border-radius:999px;background:#fff0f2;color:#c52a42;font-weight:700;text-transform:capitalize">${esc(status)}</span><br><span style="display:inline-block;margin-top:6px;color:#4b5868">${esc(row.status_comment || "Comment required")}</span></td><td style="padding:12px 10px;border-bottom:1px solid #e7ebef;color:#4b5868">${esc(dateLabel(row.non_operational_since))}</td><td style="padding:12px 10px;border-bottom:1px solid #e7ebef;color:#4b5868">${esc(dateLabel(row.expected_operational_date))}</td></tr>`;
  }).join("");
  return `<div style="overflow-x:auto;border:1px solid #dfe4e8;border-radius:14px;background:#fff"><table role="presentation" style="border-collapse:collapse;width:100%;min-width:720px;font:12px Arial,sans-serif"><thead><tr style="background:#fff3e8;color:#8c4b11">${["Vehicle", "Station", "Source", "Issue and status", "Down since", "Expected back"].map((value) => `<th style="padding:10px;text-align:left;border-bottom:1px solid #f0d8c4">${value}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function kpi(label: string, value: number, color: string, background: string) {
  return `<td class="kpi" width="20%" style="padding:5px"><div style="padding:14px 12px;border-radius:12px;background:${background};border:1px solid ${color}22"><div style="font:700 10px Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase;color:#667085">${esc(label)}</div><div style="margin-top:5px;font:900 24px Arial,sans-serif;color:${color}">${value}</div></div></td>`;
}

export function buildFleetDailyStatusEmail(input: { companyName?: string | null; date: string; rows: FleetDailyStatusSummary[]; exceptions: FleetDailyStatusVehicle[]; portalUrl?: string }) {
  const total = (key: keyof Omit<FleetDailyStatusSummary, "station">) => input.rows.reduce((sum, row) => sum + row[key], 0);
  const totalVehicles = total("ownTotal") + total("partnerTotal");
  const operational = total("ownOperational") + total("partnerOperational");
  const nonOperational = total("totalNonOperational");
  const adHoc = total("adHocVans");
  const reportDate = dateLabel(input.date);
  const portalUrl = input.portalUrl || "https://fleet.dropxlogistics.com/fleet-control?section=reports";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:680px){.shell{width:100%!important}.pad{padding:16px!important}.kpi{display:inline-block!important;width:45%!important}}</style></head><body style="margin:0;background:#f2f5f6;color:#202633"><div style="display:none;max-height:0;overflow:hidden">${esc(reportDate)}: ${totalVehicles} vehicles, ${nonOperational} non-operational and ${adHoc} approved ad hoc vans.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f6"><tr><td align="center" style="padding:24px 10px"><table class="shell" role="presentation" width="920" cellspacing="0" cellpadding="0" style="width:920px;max-width:100%;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px #111a2f12"><tr><td class="pad" style="padding:24px 28px;background:#111a2f;border-left:7px solid #d92d67"><table role="presentation" width="100%"><tr><td><div style="font:900 22px Arial,sans-serif;color:#fff"><span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:9px;background:#f15a24;margin-right:8px">F</span>DropX Fleet</div><div style="margin-top:7px;font:700 11px Arial,sans-serif;letter-spacing:1.4px;color:#f5a800">DAILY VEHICLE OPERATIONS</div></td><td align="right" style="font:700 13px Arial,sans-serif;color:#fff"><div>${esc(reportDate)}</div><div style="margin-top:5px;color:#aeb8c8;font-weight:400">${esc(input.companyName || "DropX Logistics")}</div></td></tr></table></td></tr><tr><td class="pad" style="padding:22px 24px 8px"><div style="font:900 24px Arial,sans-serif;color:#111a2f">Fleet status at a glance</div><div style="margin-top:6px;font:13px Arial,sans-serif;color:#667085">A concise view of availability, exceptions and approved ad hoc van usage across affected stations.</div></td></tr><tr><td class="pad" style="padding:8px 19px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${kpi("Vehicles", totalVehicles, "#111a2f", "#f4f6f8")}${kpi("Operational", operational, "#167a57", "#effaf5")}${kpi("Non-operational", nonOperational, "#c52a42", "#fff1f3")}${kpi("Ad hoc vans", adHoc, "#b36b00", "#fff8e6")}${kpi("Stations", input.rows.length, "#3265a8", "#eff5ff")}</tr></table></td></tr><tr><td class="pad" style="padding:8px 24px 22px"><div style="margin-bottom:10px;font:900 16px Arial,sans-serif;color:#111a2f">Station availability</div>${fleetTable(input.rows)}</td></tr><tr><td class="pad" style="padding:0 24px 22px"><div style="margin-bottom:4px;font:900 16px Arial,sans-serif;color:#111a2f">Vehicle action register</div><div style="margin-bottom:10px;font:12px Arial,sans-serif;color:#667085">Resolve missing expected dates and comments before the next daily report.</div>${exceptionTable(input.exceptions)}</td></tr><tr><td align="center" style="padding:4px 24px 28px"><a href="${esc(portalUrl)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#d92d67;color:#fff;text-decoration:none;font:800 13px Arial,sans-serif">Open Fleet control centre</a><div style="margin-top:14px;font:11px Arial,sans-serif;color:#8a94a3">Generated by DropX Fleet. Approved ad hoc van usage only; approvals remain with Operations.</div></td></tr></table></td></tr></table></body></html>`;
  const text = [`DropX Fleet daily status - ${reportDate}`, `${totalVehicles} vehicles | ${operational} operational | ${nonOperational} non-operational | ${adHoc} approved ad hoc vans`, `${input.rows.length} affected stations`, `Open Fleet: ${portalUrl}`].join("\n");
  return { html, text };
}

import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery";
import { loadAdHocActivity, type AdHocActivityStation } from "./ops-pulse/adhoc-activity";
import { adHocRegionLabel, isAdHocMailStation, loadAdHocMailScope, type AdHocMailRecipient, type AdHocMailStation } from "./adhoc-digest-scope";

type Category = "Van" | "DA" | "Driver";
type Usage = Record<Category, { count: number; amount: number }>;
const emptyUsage = (): Usage => ({ Van: { count: 0, amount: 0 }, DA: { count: 0, amount: 0 }, Driver: { count: 0, amount: 0 } });
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const regionOrder = new Map([["KL", 0], ["AP", 1], ["ODCG", 2]]);
const regionColors: Record<string, { accent: string; pale: string }> = {
  KL: { accent: "#0f766e", pale: "#e9f7f4" },
  AP: { accent: "#2563eb", pale: "#edf4ff" },
  ODCG: { accent: "#d97706", pale: "#fff5e6" }
};
const resourceColors: Record<Category, { accent: string; pale: string; border: string }> = {
  Van: { accent: "#0f766e", pale: "#e9f7f4", border: "#c9e8e2" },
  DA: { accent: "#2563eb", pale: "#edf4ff", border: "#d5e3fb" },
  Driver: { accent: "#b86305", pale: "#fff5e6", border: "#f3dfbf" }
};

export function adHocStationUsage(station: AdHocActivityStation, date: string) {
  const day = emptyUsage(), mtd = emptyUsage();
  for (const record of station.days) {
    if (record.date < `${date.slice(0, 7)}-01` || record.date > date) continue;
    for (const entry of record.entries) {
      if (!entry.countedInTotal) continue;
      const category = entry.resourceCategory ?? entry.category;
      mtd[category].count++;
      mtd[category].amount += entry.amount;
      if (record.date === date) {
        day[category].count++;
        day[category].amount += entry.amount;
      }
    }
  }
  return { day, mtd };
}

export function buildAdHocMessages(input: {
  date: string; checkedAt: string; stations: AdHocMailStation[];
  activity: AdHocActivityStation[]; recipients: AdHocMailRecipient[]; subjectTemplate: string;
}): DigestMessage[] {
  const { date } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid ad hoc report date.");
  const stationById = new Map(input.stations.filter(isAdHocMailStation).map(station => [station.id, station]));
  const rows = input.activity.flatMap(activity => {
    const station = stationById.get(activity.id), usage = adHocStationUsage(activity, date);
    return station && usage.day.Van.count > 0 ? [{
      station, cluster: String(station.cluster || activity.cluster || "Unassigned").trim() || "Unassigned",
      region: adHocRegionLabel(station), ...usage
    }] : [];
  }).sort((a, b) => (regionOrder.get(a.region) ?? 99) - (regionOrder.get(b.region) ?? 99)
    || a.cluster.localeCompare(b.cluster) || a.station.station_code.localeCompare(b.station.station_code));
  const month = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "Asia/Kolkata" });
  const subject = input.subjectTemplate.replace(/\{\{month\}\}/g, month).replace(/\{\{year\}\}/g, date.slice(0, 4));
  if (!subject || /[\r\n]/.test(subject)) throw new Error("Invalid ad hoc email subject.");
  const labels: Record<Category, string> = { Van: "Ad hoc Van", DA: "Ad hoc DA / WM", Driver: "Ad hoc Driver" };
  return input.recipients.flatMap(recipient => {
    const included = rows.filter(row => recipient.stationIds.includes(row.station.id));
    if (!included.length) return [];
    const mappedRegions = new Set(input.stations.filter(station => recipient.stationIds.includes(station.id) && isAdHocMailStation(station)).map(adHocRegionLabel));
    const showRegionBreakup = mappedRegions.size > 1;
    const grouped = [...new Set(included.map(row => row.region))].sort((a, b) => (regionOrder.get(a) ?? 99) - (regionOrder.get(b) ?? 99))
      .map(region => ({ region, rows: included.filter(row => row.region === region) }));
    const headers = ["Station Code", "Cluster", "Region", "Resource", "Previous day instances", "Previous day amount", "MTD instances", "MTD amount utilized"];
    const sumRows = (reportRows: typeof included, period: "day" | "mtd") => {
      const result = emptyUsage();
      for (const row of reportRows) for (const category of ["Van", "DA", "Driver"] as Category[]) {
        result[category].count += row[period][category].count;
        result[category].amount += row[period][category].amount;
      }
      return result;
    };
    const reportDay = sumRows(included, "day"), reportMtd = sumRows(included, "mtd");
    const reportCategories: Category[] = reportMtd.Driver.count ? ["Van", "DA", "Driver"] : ["Van", "DA"];
    const resourceCards = reportCategories.map(category => {
      const colors = resourceColors[category];
      return `<td style="padding:12px;background:${colors.pale};border:1px solid ${colors.border};border-radius:6px"><div style="font-size:11px;color:${colors.accent};text-transform:uppercase;font-weight:700">${escapeHtml(labels[category])}</div><div style="font-size:12px;color:#52656d;margin-top:7px">Previous day</div><div style="font-size:16px;font-weight:700;color:${colors.accent}">${reportDay[category].count} · ${escapeHtml(money(reportDay[category].amount))}</div><div style="font-size:12px;color:#52656d;margin-top:7px">MTD</div><div style="font-size:16px;font-weight:700;color:${colors.accent}">${reportMtd[category].count} · ${escapeHtml(money(reportMtd[category].amount))}</div></td>`;
    }).join('<td width="2%"></td>');
    const tables = grouped.map(group => {
      const colors = regionColors[group.region] ?? { accent: "#475569", pale: "#f1f5f9" };
      const dataRows: Array<{ cells: string[]; kind: "resource" | "total" }> = [];
      for (const row of group.rows) {
        const categories: Category[] = row.mtd.Driver.count ? ["Van", "DA", "Driver"] : ["Van", "DA"];
        for (const category of categories) dataRows.push({ kind: "resource", cells: [
          row.station.station_code, row.cluster, row.region, labels[category],
          String(row.day[category].count), money(row.day[category].amount), String(row.mtd[category].count), money(row.mtd[category].amount)
        ] });
      }
      const groupDay = sumRows(group.rows, "day"), groupMtd = sumRows(group.rows, "mtd");
      const groupCategories: Category[] = groupMtd.Driver.count ? ["Van", "DA", "Driver"] : ["Van", "DA"];
      const totalLabel = showRegionBreakup ? `${group.region} total` : "Report total";
      for (const category of groupCategories) dataRows.push({ kind: "total", cells: [
        totalLabel, "—", group.region, `${labels[category]} total`,
        String(groupDay[category].count), money(groupDay[category].amount),
        String(groupMtd[category].count), money(groupMtd[category].amount)
      ] });
      const body = dataRows.map(row => {
        const style = row.kind === "total" ? `font-weight:700;background:${colors.pale};color:${colors.accent};border-top:2px solid ${colors.accent}`
          : "background:#ffffff;color:#263746";
        return `<tr style="${style}">${row.cells.map((cell, index) => `<td style="padding:9px 8px;border:1px solid #dce4e8;${index >= 4 ? "text-align:right;white-space:nowrap" : ""}">${escapeHtml(cell)}</td>`).join("")}</tr>`;
      }).join("");
      const heading = showRegionBreakup ? `<div style="margin:22px 0 8px"><span style="display:inline-block;background:${colors.pale};color:${colors.accent};border-left:4px solid ${colors.accent};padding:7px 12px;font-weight:700;border-radius:4px">${escapeHtml(group.region)} region</span></div>` : "";
      const html = `${heading}<div style="overflow-x:auto"><table role="table" width="100%" style="border-collapse:collapse;font-size:12px;line-height:1.35"><thead><tr>${headers.map(header => `<th style="padding:9px 8px;text-align:left;background:#173b45;color:#ffffff;border:1px solid #365762">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
      const textRows = dataRows.map(row => row.cells.join(" | ")).join("\n");
      return { html, text: `${showRegionBreakup ? `\n${group.region} REGION\n` : "\n"}${headers.join(" | ")}\n${textRows}` };
    });
    const formatDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    const reportDate = formatDate(date), mtdStart = formatDate(`${date.slice(0, 7)}-01`);
    const periodLine = `Previous day: ${reportDate} · MTD: ${mtdStart}–${reportDate}`;
    return [{ email: recipient.email, name: recipient.name, subject,
      html: `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f4"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef3f4"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="760" cellspacing="0" cellpadding="0" style="width:100%;max-width:760px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 3px 14px rgba(22,52,62,.09)"><tr><td style="background:#173b45;border-top:5px solid #e88a2d;padding:25px 28px;color:#ffffff"><div style="font-size:11px;letter-spacing:1.4px;color:#9ed6cf;font-weight:700">OPSPULSE · DAILY COST CONTROL</div><div style="font-size:25px;font-weight:700;margin-top:6px">Ad hoc usage</div><div style="font-size:13px;color:#d9e8eb;margin-top:5px">${escapeHtml(periodLine)}</div></td></tr><tr><td style="padding:26px 28px 30px;font-family:Arial,sans-serif;color:#263746;font-size:14px;line-height:1.55"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${resourceCards}</tr></table>${tables.map(table => table.html).join("")}<div style="margin-top:18px"><a href="https://ops.dropxlogistics.com/cps/adhoc-activity?from=${date.slice(0, 7)}-01&amp;to=${date}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 15px;border-radius:6px">View details</a></div></td></tr></table></td></tr></table></body></html>`,
      text: `Ad hoc usage\n${periodLine}\n\n${reportCategories.map(category => `${labels[category]} — previous day: ${reportDay[category].count} instances, ${money(reportDay[category].amount)}; MTD: ${reportMtd[category].count} instances, ${money(reportMtd[category].amount)}`).join("\n")}\n${tables.map(table => table.text).join("\n")}\n\nView details: https://ops.dropxlogistics.com/cps/adhoc-activity?from=${date.slice(0, 7)}-01&to=${date}`,
      scope: { stationIds: included.map(row => row.station.id), reportDate: date, monthFrom: `${date.slice(0, 7)}-01`, requiresVanUsage: true }
    }];
  });
}

export const buildAdHocDigest: DigestBuilder = async (db, control, date) => {
  const scope = await loadAdHocMailScope(db, control.company_id, String(control.config.email_domain || ""));
  const activity = await loadAdHocActivity(control.company_id, scope.stations, `${date.slice(0, 7)}-01`, date);
  if (activity.error) throw new Error(activity.error);
  const checkedAt = new Date().toISOString();
  if (!control.subject_template) throw new Error("Ad hoc digest subject is not configured.");
  const messages = buildAdHocMessages({ date, checkedAt, ...scope, activity: activity.stations, subjectTemplate: control.subject_template });
  const covered = new Set(messages.flatMap(message => message.scope.stationIds as string[]));
  const unmapped = activity.stations.filter(station => adHocStationUsage(station, date).day.Van.count > 0 && !covered.has(station.id));
  if (unmapped.length) throw new Error(`Ad hoc stations have no active operations recipient: ${unmapped.map(station => station.code).join(", ")}`);
  return { checkedAt, messages };
};

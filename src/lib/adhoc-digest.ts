import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery";
import { loadAdHocActivity, type AdHocActivityStation } from "./ops-pulse/adhoc-activity";
import { adHocProgram, loadAdHocMailScope, type AdHocMailRecipient, type AdHocMailStation } from "./adhoc-digest-scope";

type Category = "Van" | "DA" | "Driver";
type Usage = Record<Category, { count: number; amount: number }>;
const emptyUsage = (): Usage => ({ Van: { count: 0, amount: 0 }, DA: { count: 0, amount: 0 }, Driver: { count: 0, amount: 0 } });
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);

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
  const { date, checkedAt } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid ad hoc report date.");
  const stationById = new Map(input.stations.filter(adHocProgram).map(station => [station.id, station]));
  const rows = input.activity.flatMap(activity => {
    const station = stationById.get(activity.id), usage = adHocStationUsage(activity, date);
    return station && usage.day.Van.count > 0 ? [{ station, ...usage }] : [];
  }).sort((a, b) => a.station.station_code.localeCompare(b.station.station_code));
  const month = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "Asia/Kolkata" });
  const subject = input.subjectTemplate.replace(/\{\{month\}\}/g, month).replace(/\{\{year\}\}/g, date.slice(0, 4));
  if (!subject || /[\r\n]/.test(subject)) throw new Error("Invalid ad hoc email subject.");
  const labels: Record<Category, string> = { Van: "Ad hoc Van", DA: "Ad hoc DA / WM", Driver: "Ad hoc Driver" };
  const note = "Counts are usage instances: one approved payment request or an unlinked cashbook entry. Linked cashbook entries are not counted twice. Pending/rejected requests are excluded. MTD covers the report month's first day through the report date. Late approvals appear in subsequent MTD figures.";
  return input.recipients.flatMap(recipient => {
    const included = rows.filter(row => recipient.stationIds.includes(row.station.id));
    if (!included.length) return [];
    const table: string[][] = [];
    for (const row of included) {
      const { station, day, mtd } = row;
      const categories: Category[] = mtd.Driver.count ? ["Van", "DA", "Driver"] : ["Van", "DA"];
      for (const category of categories) table.push([
        station.station_code, adHocProgram(station)!, labels[category],
        String(day[category].count), money(day[category].amount), String(mtd[category].count), money(mtd[category].amount)
      ]);
      const total = (usage: Usage, key: "count" | "amount") => Object.values(usage).reduce((sum, value) => sum + value[key], 0);
      table.push([station.station_code, adHocProgram(station)!, "Station total", String(total(day, "count")), money(total(day, "amount")), String(total(mtd, "count")), money(total(mtd, "amount"))]);
    }
    const headers = ["Station", "Program", "Resource", "Previous day instances", "Previous day amount", "MTD instances", "MTD amount utilized"];
    const introduction = `Ad hoc usage for ${date}. MTD: ${date.slice(0, 7)}-01 to ${date}. Only your mapped stations with ad hoc van usage on the report date are included.`;
    const checked = new Date(checkedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const body = table.map(row => `<tr${row[2] === "Station total" ? ' style="font-weight:700;background:#eef2f6"' : ""}>${row.map(cell => `<td style="padding:9px;border:1px solid #d5dce3">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
    return [{ email: recipient.email, name: recipient.name, subject,
      html: `<div style="font-family:Arial,sans-serif;color:#172b3a;font-size:14px"><h2>Daily ad hoc usage</h2><p>Hello ${escapeHtml(recipient.name)},</p><p>${escapeHtml(introduction)}</p><table style="border-collapse:collapse;font-size:13px"><thead><tr>${headers.map(header => `<th style="padding:9px;text-align:left;background:#172b3a;color:white;border:1px solid #d5dce3">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table><p>${escapeHtml(note)}</p><p>Data checked at ${escapeHtml(checked)} IST.</p><p><a href="https://ops.dropxlogistics.com/cps/adhoc-activity?from=${date.slice(0, 7)}-01&amp;to=${date}">View ad hoc details in OpsPulse</a></p></div>`,
      text: `Hello ${recipient.name},\n\n${introduction}\n\n${[headers, ...table].map(row => row.join(" | ")).join("\n")}\n\n${note}\nData checked at ${checked} IST.`,
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

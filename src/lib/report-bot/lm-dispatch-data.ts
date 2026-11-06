import "server-only";
import { fetchLoadFlashBoard, fetchEddStation, fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { fetchCodStatus } from "@/lib/ops-pulse/cash-recon-worker";
import { loadCodPendingReport } from "@/lib/ops-pulse/cod-pending-data";
import { CRETURN_DISPLAY, CRETURN_SHORT } from "@/lib/ops-pulse/station-board";
import { reportBotDb } from "./settings";
import type { ReportKey } from "./lm-dispatch-config";

export type DispatchReport = { asOf: string; rows: [string, string | number][]; pending: boolean };
export function istDay(now: Date) { return new Date(+now + 330 * 60000).toISOString().slice(0, 10); }
function fresh(stamp: string | null, day: string) {
  const at = Date.parse(stamp || "");
  if (!Number.isFinite(at) || istDay(new Date(at)) !== day || Date.now() - at > 90 * 60000 || at > Date.now() + 60000) throw new Error("Current station data unavailable or older than 90 minutes.");
  return stamp!;
}
const money = (value: number) => "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
export async function loadDispatchReport(key: ReportKey, company: string, location: string, code: string, day: string): Promise<DispatchReport> {
  if (key === "slip") {
    const [r] = await loadCodPendingReport(reportBotDb(), company, [location], false, day);
    if (!r) throw new Error("No COD slip report for this station.");
    return { asOf: new Date().toISOString(), pending: r.pending, rows: [["Status", r.status], ["Slip uploaded", r.slipUploaded ? "Yes" : "No"], ["Deposit", r.amount === null ? "—" : money(r.amount)]] };
  }
  if (["cod", "recon", "deposit", "bank"].includes(key)) {
    const s = await fetchCodStatus(code);
    if (s.date !== day || s.stationCode !== code) throw new Error("COD snapshot did not match the requested station and date.");
    const asOf = fresh(s.fetchedAt, day);
    const rows: DispatchReport["rows"] = [];
    let pending = false;
    if (key === "cod" || key === "recon") {
      const c = s.reconciliation;
      if (!c.data || c.state !== "ok") throw new Error("DA reconciliation unavailable.");
      fresh(c.checkedAt, day);
      rows.push(["DAs pending", c.data.pendingCount], ["Cash pending", money(c.data.pendingAmount)]);
      pending ||= c.data.pendingAmount > 0 || c.data.pendingCount > 0;
    }
    if (key === "cod" || key === "deposit") {
      const c = s.prepareDeposit;
      if (!c.data || c.state !== "ok") throw new Error("Deposit balance unavailable.");
      fresh(c.checkedAt, day); rows.push(["Cash to prepare", money(c.data.actualAmount)]);
      pending ||= c.data.actualAmount > 0;
    }
    if (key === "cod" || key === "bank") {
      const c = s.remittances;
      if (!c.data || c.state !== "ok") throw new Error("Remittance balance unavailable.");
      fresh(c.checkedAt, day); rows.push(["Open remittances", c.data.openCount], ["Open amount", money(c.data.openAmount)]);
      pending ||= c.data.openCount > 0;
    }
    return { asOf, pending, rows };
  }
  if (key === "scrub") {
    const s = (await fetchScrubNetwork([code])).stations.find(s => s.stationCode === code);
    if (!s || s.inStation.error || s.onRoad.error) throw new Error("Scrub activity unavailable.");
    const today = (items: { at: string }[]) => items.filter(item => istDay(new Date(item.at)) === day).length;
    const station = today(s.inStation.invocations), road = today(s.onRoad.invocations);
    return { asOf: fresh(s.fetchedAt, day), pending: !station || !road, rows: [["In-station checks", station], ["On-road checks", road]] };
  }
  if (key === "edd" || key === "station") {
    const result = await fetchEddStation({ stationCode: code });
    if (result.status !== "ok" || result.payload.todayYmd !== day || result.payload.stationCode !== code) throw new Error("No current EDD snapshot.");
    const s = result.payload, b = s.buckets;
    return { asOf: fresh(s.fetchedAt, day), pending: key === "edd" ? b.dueToday + b.overdue > 0 : s.totalCount > 0,
      rows: key === "edd" ? [["Due today", b.dueToday], ["Overdue", b.overdue]] :
        [["At station", s.totalCount], ["Overdue", b.overdue], ["Due today", b.dueToday], ["Due tomorrow", b.dueTomorrow], ["Later", b.future], ["EDD unknown", b.unknown]] };
  }
  const s = (await fetchLoadFlashBoard(day, [code])).stations.find(s => s.stationCode === code && s.businessDate === day && s.hasSnapshot);
  if (!s) throw new Error("Station board unavailable for this date.");
  const asOf = fresh(s.fetchedAt, day), b = s.board;
  if (key === "ageing") {
    const cells = Object.entries(b.ageingByDay);
    return { asOf, pending: cells.some(([, v]) => v.count > 0), rows: cells.length ? cells.map(([k, v]) => [k, v.count + " · " + money(v.amount)]) : [["Ageing shipments", 0]] };
  }
  if (key === "creturn") {
    const active = ["AT_STATION", "DELAYED", "ON_ROAD_WITH_DELIVERY_ASSOCIATE"];
    return { asOf, pending: active.some(k => (b.cReturn[k] || 0) > 0), rows: [["Total", b.cReturnTotal], ...CRETURN_DISPLAY.map((k): [string,number] => [CRETURN_SHORT[k], b.cReturn[k] || 0]), ["Pickup %", b.pickupDonePct.toFixed(2) + "%"]] };
  }
  const das = b.daDsr, zero = das.filter(d => !d.delivered && d.total > 0).sort((a,b) => b.total-a.total);
  const rows: DispatchReport["rows"] = [];
  if (key === "zero") {
    rows.push(["Zero-delivery rows", zero.length], ...zero.map((d): [string,number] => [d.driverName || d.driverId || "Unassigned", d.total]));
  } else {
    const sum = (key: "delivered"|"total"|"failed"|"rejected"|"oor") => das.reduce((n,d) => n+d[key],0);
    const total=sum("total"), delivered=sum("delivered");
    rows.push(["Total",total],["Delivered",delivered],["On road",sum("oor")],["Failed",sum("failed")],["Rejected",sum("rejected")],["DSR",total ? (100*delivered/total).toFixed(2)+"%" : "—"]);
  }
  if (b.dsrHistoryPending) rows.push(["History checks pending", b.dsrHistoryPending]);
  return { asOf, rows, pending: key === "zero" ? zero.length > 0 : das.some(d => d.delivered < d.total) };
}

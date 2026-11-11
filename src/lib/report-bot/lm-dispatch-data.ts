import "server-only";
import { fetchLoadFlashBoard, fetchLoadFlashTracking, fetchEddStation, fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { BOARD_TID, mapBoardTidExportRows, type BoardTidExportRow } from "@/lib/ops-pulse/station-board-tids";
import { fetchCodStatus } from "@/lib/ops-pulse/cash-recon-worker";
import { loadCodPendingReport } from "@/lib/ops-pulse/cod-pending-data";
import { CRETURN_DISPLAY, CRETURN_SHORT } from "@/lib/ops-pulse/station-board";
import { stationDotTotals } from "@/lib/ops-pulse/dot-metrics";
import { reportBotDb } from "./settings";
import type { ReportKey } from "./lm-dispatch-config";
import { orderEodCReturnRows, orderEodDotRows, orderEodDsrRows } from "./lm-eod-order";
import { eodDotRow, type EodDotRow } from "./lm-eod-dot";

export type DispatchReport = { asOf: string; rows: [string, string | number][]; pending: boolean };
export type TodayEddStation = { stationCode: string; count: number; trackingIds: BoardTidExportRow[]; asOf: string };
export type TodayEddSnapshot = { asOf: string; stations: TodayEddStation[]; unverifiedStations: string[]; pending: boolean };
export type EodDsrRow = { Station:string; "Verified total":number; Delivered:number; "Delivery failed":number; Rejected:number; "On road":number; "DSR %":string };
export type EodCReturnRow = { Station:string; Total:number; "Picked up":number; "Pending pickup":number; "Pickup %":string };
export type EodDigest = { asOf:string; missingStations:string[]; dsr:EodDsrRow[]; dot:EodDotRow[]; creturn:EodCReturnRow[] };
export function istDay(now: Date) { return new Date(+now + 330 * 60000).toISOString().slice(0, 10); }
function fresh(stamp: string | null, day: string) {
  const at = Date.parse(stamp || "");
  if (!Number.isFinite(at) || istDay(new Date(at)) !== day || Date.now() - at > 90 * 60000 || at > Date.now() + 60000) throw new Error("Current station data unavailable or older than 90 minutes.");
  return stamp!;
}
const money = (value: number) => "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * Exact Today EDD queue used by the Last Mile Report Bot. A station is eligible
 * only after the station-inventory reconciliation completed (version 2). The
 * package source is BoardPendingToday: due today, physically at station, and
 * never dispatched/attempted. The requested station allow-list is reapplied
 * because older workers may ignore their stations query parameter.
 */
export async function loadTodayEddSnapshot(stationCodes: string[], day: string): Promise<TodayEddSnapshot> {
  const requested = [...new Set(stationCodes.map(code => code.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new Error("No active source stations are configured.");
  const board = await fetchLoadFlashBoard(day, requested);
  const byCode = new Map(board.stations.filter(row => row.businessDate === day).map(row => [row.stationCode, row]));
  const verified = requested.filter(code => {
    const row = byCode.get(code);
    return Boolean(row?.hasSnapshot && row.board.stationInventoryVersion === 2);
  });
  const unverifiedStations = requested.filter(code => !verified.includes(code));
  if (!verified.length) throw new Error("Today EDD source is not verified for the configured stations yet.");
  const tracking = await fetchLoadFlashTracking(day, verified, { buckets: [BOARD_TID.PENDING_TODAY] });
  const allowed = new Set(verified);
  const exact = mapBoardTidExportRows(
    tracking.filter(row => allowed.has(row.stationCode) && row.edd === day),
    "edd-today",
  );
  const stations = verified.map((stationCode) => {
    const source = byCode.get(stationCode)!;
    const trackingIds = exact.filter(row => row.stationCode === stationCode);
    return { stationCode, count: trackingIds.length, trackingIds, asOf: fresh(source.fetchedAt, day) };
  }).sort((a, b) => b.count - a.count || a.stationCode.localeCompare(b.stationCode));
  const asOf = stations.map(row => row.asOf).sort().at(-1) ?? board.asOf;
  return { asOf, stations, unverifiedStations, pending: stations.some(row => row.count > 0) };
}

export async function loadEodDigest(stationCodes: string[], day: string): Promise<EodDigest> {
  const requested = [...new Set(stationCodes.map(code => code.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new Error("No active source stations are configured.");
  const network = await fetchLoadFlashBoard(day, requested);
  const allowed = new Set(requested);
  const stations = network.stations.filter(row => allowed.has(row.stationCode) && row.businessDate === day && row.hasSnapshot);
  const missingStations = requested.filter(code => !stations.some(row => row.stationCode === code));
  const dsr:EodDsrRow[] = [];
  const dot:EodDotRow[] = [];
  const creturn:EodCReturnRow[] = [];
  const stamps:string[] = [];
  for (const station of stations.sort((a,b)=>a.stationCode.localeCompare(b.stationCode))) {
    stamps.push(fresh(station.fetchedAt, day));
    const das = station.board.daDsr;
    const sum = (key:"delivered"|"failed"|"rejected"|"oor"|"total") => das.reduce((total,row)=>total+Number(row[key] || 0),0);
    const delivered = sum("delivered");
    const known = delivered + sum("failed") + sum("rejected") + sum("oor");
    dsr.push({Station:station.stationCode,"Verified total":known,Delivered:delivered,"Delivery failed":sum("failed"),Rejected:sum("rejected"),"On road":sum("oor"),"DSR %":known ? `${(delivered/known*100).toFixed(1)}%` : "—"});
    dot.push(eodDotRow(station.stationCode, stationDotTotals(station.board,"standard"), stationDotTotals(station.board,"premium")));
    const total = Number(station.board.cReturnTotal || 0), picked = Number(station.board.cReturn.PICKUP_DONE || 0);
    creturn.push({Station:station.stationCode,Total:total,"Picked up":picked,"Pending pickup":Math.max(0,total-picked),"Pickup %":total ? `${(picked/total*100).toFixed(1)}%` : "—"});
  }
  if (!stations.length) throw new Error("No current station snapshots are available for this region.");
  return {
    asOf: stamps.sort().at(-1) || network.asOf,
    missingStations,
    dsr: orderEodDsrRows(dsr),
    dot: orderEodDotRows(dot),
    creturn: orderEodCReturnRows(creturn),
  };
}

export async function loadDispatchReport(key: ReportKey, company: string, location: string, code: string, day: string): Promise<DispatchReport> {
  if (key === "eod") throw new Error("Final EOD is generated from its configured multi-station scope.");
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
    if (key === "edd") {
      const exact = await loadTodayEddSnapshot([code], day);
      const station = exact.stations[0];
      return {
        asOf: exact.asOf,
        pending: station.count > 0,
        rows: [["Today EDD pending", station.count], ...station.trackingIds.map(row => ["TID", row.trackingId] as [string, string])],
      };
    }
    const result = await fetchEddStation({ stationCode: code });
    if (result.status !== "ok" || result.payload.todayYmd !== day || result.payload.stationCode !== code) throw new Error("No current EDD snapshot.");
    const s = result.payload, b = s.buckets;
    return { asOf: fresh(s.fetchedAt, day), pending: s.totalCount > 0,
      rows: [["At station", s.totalCount], ["Overdue", b.overdue], ["Due today", b.dueToday], ["Due tomorrow", b.dueTomorrow], ["Later", b.future], ["EDD unknown", b.unknown]] };
  }
  if (key === "oor") {
    const station = (await fetchLoadFlashBoard(day, [code])).stations.find(row => row.stationCode === code && row.businessDate === day && row.hasSnapshot);
    if (!station) throw new Error("Station board unavailable for this date.");
    const asOf = fresh(station.fetchedAt, day);
    const outOnRoad = station.board.daDsr.reduce((total, row) => total + Number(row.oor || 0), 0);
    return { asOf, pending: outOnRoad > 0, rows: [["Out on road", outOnRoad]] };
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

import "server-only";
import { fetchLoadFlashBoard, fetchLoadFlashTracking, fetchEddStation, fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { BOARD_TID, mapBoardTidExportRows, type BoardTidExportRow } from "@/lib/ops-pulse/station-board-tids";
import { fetchCodStatus } from "@/lib/ops-pulse/cash-recon-worker";
import { loadCodPendingReport } from "@/lib/ops-pulse/cod-pending-data";
import { pickupPolicy } from "@/lib/ops-pulse/cod-pickup";
import { collectionDay } from "@/lib/ops-pulse/cod-reconciliation";
import { AGEING_DAY_BUCKETS, CRETURN_DISPLAY, CRETURN_SHORT } from "@/lib/ops-pulse/station-board";
import { stationDotTotals } from "@/lib/ops-pulse/dot-metrics";
import { reportBotDb } from "./settings";
import type { ReportKey } from "./lm-dispatch-config";
import { orderEodCReturnRows, orderEodDotRows, orderEodDsrRows } from "./lm-eod-order";
import { eodDotRow, type EodDotRow } from "./lm-eod-dot";
import { overdueRemittancesAfterGrace, scrubAlertState, slipUploadOverdue, submittedRemittanceAt } from "./lm-cod-alerts";

export type DispatchReport = { asOf: string; rows: [string, string | number][]; pending: boolean };
export type TodayEddStation = { stationCode: string; count: number; trackingIds: BoardTidExportRow[]; asOf: string };
export type TodayEddSnapshot = { asOf: string; stations: TodayEddStation[]; unverifiedStations: string[]; pending: boolean };
export type EodDsrRow = { Station:string; "Verified total":number; Delivered:number; "Delivery failed":number; Rejected:number; "On road":number; "DSR %":string };
export type EodCReturnRow = { Station:string; Total:number; "Picked up":number; "Pending pickup":number; "Pickup %":string };
export type EodDigest = {
  asOf:string;
  missingStations:string[];
  stationInventory:Record<string,{eddAtStation:number|null;physicalAtStation:number|null}>;
  stationInventoryTracking:{edd:BoardTidExportRow[];physical:BoardTidExportRow[]};
  dsr:EodDsrRow[];
  dot:EodDotRow[];
  creturn:EodCReturnRow[];
};
export type AgeingCell = { count:number; amount:number };
export type AgeingDigest = {
  asOf:string;
  missingStations:string[];
  dayBuckets:string[];
  weekBuckets:string[];
  byStation:Array<{stationCode:string; byDay:Record<string,AgeingCell>; byWeek:Record<string,AgeingCell>; total:AgeingCell}>;
  trackingIds:BoardTidExportRow[];
};
export function istDay(now: Date) { return new Date(+now + 330 * 60000).toISOString().slice(0, 10); }
function fresh(stamp: string | null, day: string) {
  const at = Date.parse(stamp || "");
  if (!Number.isFinite(at) || istDay(new Date(at)) !== day || Date.now() - at > 90 * 60000 || at > Date.now() + 60000) throw new Error("Current station data unavailable or older than 90 minutes.");
  return stamp!;
}
const money = (value: number) => "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function reconciliationAlertRows(data:NonNullable<Awaited<ReturnType<typeof fetchCodStatus>>["reconciliation"]["data"]>,day:string) {
  const dayMs=Date.parse(`${day}T00:00:00Z`);
  const drivers=(data.drivers || []).filter(driver=>Math.abs(Number(driver.pendingAmount)||0)>=0.01).map(driver=>{
    const dated=(driver.packages || []).map(pkg=>collectionDay(pkg.collectedAt)).filter((value):value is string=>Boolean(value));
    const oldestDays=dated.length ? Math.max(...dated.map(value=>Math.max(0,Math.floor((dayMs-Date.parse(`${value}T00:00:00Z`))/86400000)))) : null;
    return {...driver,oldestDays};
  }).sort((a,b)=>(b.oldestDays??-1)-(a.oldestDays??-1)||Math.abs(b.pendingAmount)-Math.abs(a.pendingAmount));
  const priorDayDrivers=drivers.filter(driver=>(driver.oldestDays??0)>=1);
  return [
    ["DAs pending",data.pendingCount] as [string,string|number],
    ["Cash pending",money(data.pendingAmount)] as [string,string|number],
    ...(priorDayDrivers.length ? [["Prior-day DAs",priorDayDrivers.length] as [string,string|number]] : []),
    ...drivers.map(driver=>[
      `${driver.name || driver.id}${driver.oldestDays===null?" · age unknown":driver.oldestDays>=1?` · ${driver.oldestDays}d ageing`:" · today"}`,
      `${money(driver.pendingAmount)} · ${(driver.packages || []).length} TID${(driver.packages || []).length===1?"":"s"}`,
    ] as [string,string|number]),
  ];
}

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
  const stationInventory:Record<string,{eddAtStation:number|null;physicalAtStation:number|null}> = Object.fromEntries(stations.map(row=>[row.stationCode,{eddAtStation:null,physicalAtStation:null}]));
  const stationInventoryTracking:{edd:BoardTidExportRow[];physical:BoardTidExportRow[]}={edd:[],physical:[]};
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
  try {
    const inventory=await fetchLoadFlashTracking(day,stations.map(row=>row.stationCode),{buckets:[BOARD_TID.EDD,BOARD_TID.PHYSICAL]});
    const unique=new Map<string,{edd:Set<string>;physical:Set<string>}>();
    for(const station of stations) unique.set(station.stationCode,{edd:new Set(),physical:new Set()});
    for(const row of inventory) {
      const bucket=unique.get(row.stationCode);
      if(!bucket||!row.trackingId) continue;
      if(row.bucket===BOARD_TID.EDD) bucket.edd.add(row.trackingId);
      if(row.bucket===BOARD_TID.PHYSICAL) bucket.physical.add(row.trackingId);
    }
    for(const [stationCode,counts] of unique) stationInventory[stationCode]={eddAtStation:counts.edd.size,physicalAtStation:counts.physical.size};
    stationInventoryTracking.edd=mapBoardTidExportRows(inventory.filter(row=>row.bucket===BOARD_TID.EDD),"edd");
    stationInventoryTracking.physical=mapBoardTidExportRows(inventory.filter(row=>row.bucket===BOARD_TID.PHYSICAL),"dsr-station");
  } catch {
    // Keep the live DSR available when the package-level inventory endpoint is
    // temporarily unavailable; its two inventory columns will show em dashes.
  }
  return {
    asOf: stamps.sort().at(-1) || network.asOf,
    missingStations,
    stationInventory,
    stationInventoryTracking,
    dsr: orderEodDsrRows(dsr),
    dot: orderEodDotRows(dot),
    creturn: orderEodCReturnRows(creturn),
  };
}

function addAgeingCells(cells:AgeingCell[]) {
  return cells.reduce((total,cell)=>({count:total.count+Number(cell.count||0),amount:Math.round((total.amount+Number(cell.amount||0)+Number.EPSILON)*100)/100}),{count:0,amount:0});
}

/** Regional ageing uses the verified Station Board summary for TID/value
 * buckets and the worker's BoardAgeing rows for the row-level workbook. */
export async function loadAgeingDigest(stationCodes:string[],day:string):Promise<AgeingDigest> {
  const requested=[...new Set(stationCodes.map(code=>code.trim().toUpperCase()).filter(Boolean))];
  if(!requested.length) throw new Error("No active source stations are configured.");
  const network=await fetchLoadFlashBoard(day,requested);
  const allowed=new Set(requested);
  const stations=network.stations.filter(row=>allowed.has(row.stationCode)&&row.businessDate===day&&row.hasSnapshot);
  if(!stations.length) throw new Error("No current ageing snapshots are available for this region.");
  const missingStations=requested.filter(code=>!stations.some(row=>row.stationCode===code));
  const stamps=stations.map(row=>fresh(row.fetchedAt,day));
  const weekBuckets=[...new Set(stations.flatMap(row=>Object.keys(row.board.ageingByWeek||{})))].sort();
  const byStation=stations.sort((a,b)=>a.stationCode.localeCompare(b.stationCode)).map(station=>{
    const byDay=Object.fromEntries(AGEING_DAY_BUCKETS.map(bucket=>[bucket,station.board.ageingByDay?.[bucket]||{count:0,amount:0}])) as Record<string,AgeingCell>;
    const byWeek=Object.fromEntries(weekBuckets.map(bucket=>[bucket,station.board.ageingByWeek?.[bucket]||{count:0,amount:0}])) as Record<string,AgeingCell>;
    return {stationCode:station.stationCode,byDay,byWeek,total:addAgeingCells(Object.values(byDay))};
  });
  const flash=await fetchLoadFlashTracking(day,stations.map(row=>row.stationCode),{buckets:[BOARD_TID.AGEING]});
  const trackingIds=mapBoardTidExportRows(flash.filter(row=>allowed.has(row.stationCode)),"ageing");
  return {asOf:stamps.sort().at(-1)||network.asOf,missingStations,dayBuckets:[...AGEING_DAY_BUCKETS],weekBuckets,byStation,trackingIds};
}

export async function loadDispatchReport(key: ReportKey, company: string, location: string, code: string, day: string): Promise<DispatchReport> {
  if (key === "eod") throw new Error("Final EOD is generated from its configured multi-station scope.");
  if (key === "slip") {
    const [r,s] = await Promise.all([
      loadCodPendingReport(reportBotDb(), company, [location], false, day).then(rows=>rows[0]),
      fetchCodStatus(code),
    ]);
    if (!r) throw new Error("No COD slip report for this station.");
    if(s.date!==day||s.stationCode!==code) throw new Error("COD snapshot did not match the requested station and date.");
    const remittances=s.remittances;
    if(!remittances.data||remittances.state!=="ok") throw new Error("Remittance status unavailable for slip timing.");
    const asOf=fresh(remittances.checkedAt,day),latest=remittances.data.latestSubmitted;
    const pending=r.pending&&slipUploadOverdue(latest,new Date(),30),submittedAt=submittedRemittanceAt(latest);
    return { asOf, pending, rows: [["Status", r.status], ["Slip uploaded", r.slipUploaded ? "Yes" : "No"], ["Latest remittance", latest?.code||"Not submitted"], ["Remittance submitted", submittedAt?new Date(submittedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" IST":"—"], ["Deposit", r.amount === null ? "—" : money(r.amount)]] };
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
      rows.push(...reconciliationAlertRows(c.data,day));
      pending ||= c.data.pendingAmount > 0 || c.data.pendingCount > 0;
    }
    if (key === "cod" || key === "deposit") {
      const c = s.prepareDeposit;
      if (!c.data || c.state !== "ok") throw new Error("Deposit balance unavailable.");
      fresh(c.checkedAt, day);
      rows.push(["Expected cash",money(c.data.expectedAmount)],["Cash to prepare", money(c.data.actualAmount)],["Difference",money(c.data.variance)]);
      pending ||= c.data.actualAmount > 0;
    }
    if (key === "cod" || key === "bank") {
      const c = s.remittances;
      if (!c.data || c.state !== "ok") throw new Error("Remittance balance unavailable.");
      fresh(c.checkedAt, day);
      if(key==="bank") {
        const setting=await reportBotDb().from("cod_station_settings").select("pickup_configured,pickup_rule,pickup_window_start,pickup_window_end,next_day_preparation_from").eq("company_id",company).eq("location_id",location).eq("is_active",true).maybeSingle();
        if(setting.error) throw new Error(setting.error.message);
        const policy=pickupPolicy(setting.data);
        if(!policy) throw new Error("COD pickup timing is not configured for this station.");
        const overdue=overdueRemittancesAfterGrace(c.data.rows,c.data.latestSubmitted,policy,new Date(),30);
        const overdueAmount=overdue.reduce((sum,item)=>sum+Math.max(0,Number(item.row.expectedAmount)||0),0);
        const requiredAction=policy.rule==="Same Day-Complete"
          ? "Hand over all COD today · no COD can be held overnight"
          : policy.rule==="Same Day-Partial"
            ? "Hand over all COD available by pickup; later cash follows the next pickup"
            : "Hand over all COD in the configured next-day pickup";
        rows.push(["Pickup rule",policy.rule],["Required action",requiredAction],["Pickup window",`${policy.start}–${policy.end} IST`],["Overdue remittances",overdue.length],["Overdue amount",money(overdueAmount)]);
        if(overdue[0]) rows.push(["Reason",overdue[0].reason]);
        pending ||= overdue.length>0;
      } else {
        rows.push(["Open remittances", c.data.openCount], ["Open amount", money(c.data.openAmount)]);
        pending ||= c.data.openCount > 0;
      }
    }
    return { asOf, pending, rows };
  }
  if (key === "scrub") {
    const s = (await fetchScrubNetwork([code])).stations.find(s => s.stationCode === code);
    if (!s || s.inStation.error || s.onRoad.error) throw new Error("Scrub activity unavailable.");
    const today = (items: { at: string }[]) => items.filter(item => istDay(new Date(item.at)) === day).length;
    const station = today(s.inStation.invocations), road = today(s.onRoad.invocations);
    const alert=scrubAlertState(day,new Date(),station,road);
    return { asOf: fresh(s.fetchedAt, day), pending: alert.pending, rows: alert.rows };
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

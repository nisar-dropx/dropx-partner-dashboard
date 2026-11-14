import {loadProgressScrub} from './lm-scrub-data';
import {verifiedPhysicalCount,cReturnSummary,requireReportFreshness,type CReturnSummary} from './lm-live-report';
import "server-only";
import { fetchLoadFlashBoard, fetchLoadFlashTracking, queueLoadFlashStations, fetchEddStation } from "@/lib/ops-pulse/edd-worker";
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
import { bankRemittanceFollowup, observedBankerWindow, observedNonPickupWeekday, overdueRemittancesAfterGrace, prepareDepositAlertState, reconciliationDriverAlert, slipReminderState, submittedRemittanceAt } from "./lm-cod-alerts";

export type DispatchReport = {
  asOf: string;
  rows: [string, string | number][];
  pending: boolean;
  table?: { columns: string[]; rows: Array<Array<string | number>> };
};
export type TodayEddStation = { stationCode: string; count: number; trackingIds: BoardTidExportRow[]; asOf: string };
export type TodayEddSnapshot = { asOf: string; stations: TodayEddStation[]; unverifiedStations: string[]; pending: boolean };
export type EodDsrRow = { Station:string; "Verified total":number; Delivered:number; "Delivery failed":number; Rejected:number; "On road":number; "DSR %":string };
export type EodCReturnRow = CReturnSummary;
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
function fresh(stamp: string | null, day: string, maxMinutes=90) {
  return requireReportFreshness(stamp,day,maxMinutes);
}
const money = (value: number) => "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function reconciliationAlertRows(data:NonNullable<Awaited<ReturnType<typeof fetchCodStatus>>["reconciliation"]["data"]>,day:string,now=new Date()) {
  const dayMs=Date.parse(`${day}T00:00:00Z`);
  const drivers=(data.drivers || []).filter(driver=>Math.abs(Number(driver.pendingAmount)||0)>=0.01).map(driver=>{
    const dated=(driver.packages || []).map(pkg=>collectionDay(pkg.collectedAt)).filter((value):value is string=>Boolean(value));
    const oldestDays=dated.length ? Math.max(...dated.map(value=>Math.max(0,Math.floor((dayMs-Date.parse(`${value}T00:00:00Z`))/86400000)))) : null;
    const lastDeliveryAt=Math.max(0,...(driver.packages||[]).map(pkg=>Number(pkg.collectedAt)||0))||null;
    return {...driver,oldestDays,lastDeliveryAt,alert:reconciliationDriverAlert(lastDeliveryAt,now,90,"22:00")};
  }).filter(driver=>driver.alert.due).sort((a,b)=>(b.oldestDays??-1)-(a.oldestDays??-1)||Math.abs(b.pendingAmount)-Math.abs(a.pendingAmount));
  const priorDayDrivers=drivers.filter(driver=>(driver.oldestDays??0)>=1);
  const rows = [
    ["DAs requiring reconciliation",drivers.length] as [string,string|number],
    ["Cash with listed DAs",money(drivers.reduce((sum,driver)=>sum+Number(driver.pendingAmount||0),0))] as [string,string|number],
    ["Rule",drivers.some(driver=>driver.alert.fullSweep)?"10 PM closing sweep · all pending DAs":"90 minutes after last COD delivery"] as [string,string|number],
    ...(priorDayDrivers.length ? [["Prior-day DAs",priorDayDrivers.length] as [string,string|number]] : []),
    ...drivers.map(driver=>[
      `${driver.name || driver.id}${driver.oldestDays===null?" · age unknown":driver.oldestDays>=1?` · ${driver.oldestDays}d ageing`:" · today"}`,
      `${driver.lastDeliveryAt?new Date(driver.lastDeliveryAt).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" last delivery":"last delivery unverified"} · ${money(driver.pendingAmount)} · ${(driver.packages || []).length} TID${(driver.packages || []).length===1?"":"s"}`,
    ] as [string,string|number]),
  ];
  const clock=(value:number|null)=>value
    ? new Date(value).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})
    : "Unverified";
  const tableRows=drivers.map(driver=>{
    const dueAt=driver.lastDeliveryAt ? driver.lastDeliveryAt+90*60000 : null;
    const age=driver.oldestDays===null ? "Unknown" : driver.oldestDays>=1 ? `${driver.oldestDays}d` : "Today";
    const overdue=driver.alert.elapsedMinutes===null ? "Closing sweep" : `${Math.max(0,driver.alert.elapsedMinutes-90)}m overdue`;
    return [driver.name||driver.id,clock(driver.lastDeliveryAt),clock(dueAt),money(driver.pendingAmount),(driver.packages||[]).length,age,overdue] as Array<string|number>;
  });
  return {rows,table:{columns:["DA","Last delivery","90-min due","Pending ₹","TIDs","Age","Status"],rows:tableRows}};
}

async function prepareDepositOperations(code:string,day:string,pendingAmount:number,now=new Date()) {
  const board=await fetchLoadFlashBoard(day,[code]);
  const station=board.stations.find(row=>row.stationCode===code&&row.businessDate===day&&row.hasSnapshot);
  if(!station) throw new Error("Current station OOR snapshot unavailable for Prepare Deposit timing.");
  const outOnRoad=station.board.daDsr.reduce((sum,row)=>sum+Number(row.oor||0),0);
  let closureAt:number|null=null;
  if(outOnRoad===0) {
    const rows=await fetchLoadFlashTracking(day,[code]);
    const terminal=new Set(["DELIVERED","DELIVERY_ATTEMPTED","DELIVERY_FAILED","DELIVERY_REJECTED","REJECTED"]);
    const updates=rows.filter(row=>row.stationCode===code&&row.edd===day&&(row.delivered||terminal.has(row.state.toUpperCase())))
      .map(row=>Date.parse(row.lastUpdatedAt||"")).filter(Number.isFinite);
    closureAt=updates.length?Math.max(...updates):null;
  }
  return {outOnRoad,alert:prepareDepositAlertState(outOnRoad,closureAt,pendingAmount,now,120,"22:00")};
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
  const stale=verified.filter(code=>{try{requireReportFreshness(byCode.get(code)!.fetchedAt,day,5);return false;}catch{return true;}});
  if(stale.length){await queueLoadFlashStations(stale,5);throw new Error('Waiting for fresh EDD status: '+stale.join(', '));}
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

export async function loadEodDigest(stationCodes: string[], day: string, options:{maxAgeMinutes?:number;requireCReturn?:boolean;allowPartial?:boolean}={}): Promise<EodDigest> {
  const requested = [...new Set(stationCodes.map(code => code.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new Error("No active source stations are configured.");
  const network = await fetchLoadFlashBoard(day, requested);
  const allowed = new Set(requested);
  let stations = network.stations.filter(row => allowed.has(row.stationCode) && row.businessDate === day && row.hasSnapshot);
  let missingStations = requested.filter(code => !stations.some(row => row.stationCode === code));
  if (options.maxAgeMinutes === 5) {
    const stale = requested.filter(code => {
      const station = stations.find(row => row.stationCode === code);
      try { requireReportFreshness(station?.fetchedAt ?? null, day, 5); return false; } catch { return true; }
    });
    if (stale.length) {
      await queueLoadFlashStations(stale, 5);
      if(!options.allowPartial)throw new Error("Waiting for current refresh: " + stale.join(", "));
      missingStations=[...new Set([...missingStations,...stale])];
      stations=stations.filter(station=>!stale.includes(station.stationCode));
    }
  }
  const dsr:EodDsrRow[] = [];
  const dot:EodDotRow[] = [];
  const creturn:EodCReturnRow[] = [];
  const stationInventory:Record<string,{eddAtStation:number|null;physicalAtStation:number|null}> = Object.fromEntries(stations.map(row=>[row.stationCode,{eddAtStation:null,physicalAtStation:null}]));
  const stationInventoryTracking:{edd:BoardTidExportRow[];physical:BoardTidExportRow[]}={edd:[],physical:[]};
  const stamps:string[] = [];
  for (const station of stations.sort((a,b)=>a.stationCode.localeCompare(b.stationCode))) {
    stamps.push(fresh(station.fetchedAt, day,options.maxAgeMinutes??90));
    const das = station.board.daDsr;
    const sum = (key:"delivered"|"failed"|"rejected"|"oor"|"total") => das.reduce((total,row)=>total+Number(row[key] || 0),0);
    const delivered = sum("delivered");
    const known = delivered + sum("failed") + sum("rejected") + sum("oor");
    dsr.push({Station:station.stationCode,"Verified total":known,Delivered:delivered,"Delivery failed":sum("failed"),Rejected:sum("rejected"),"On road":sum("oor"),"DSR %":known ? `${(delivered/known*100).toFixed(1)}%` : "—"});
    dot.push(eodDotRow(station.stationCode, stationDotTotals(station.board,"standard"), stationDotTotals(station.board,"premium")));

  }
  if (!stations.length || (missingStations.length&&!options.allowPartial)) throw new Error("Current station snapshots missing: "+missingStations.join(", "));
  try {
    const inventory=await fetchLoadFlashTracking(day,stations.map(row=>row.stationCode),{buckets:[BOARD_TID.EDD,BOARD_TID.PHYSICAL,BOARD_TID.CRETURN]});
    for(const station of stations){
      const rows=inventory.filter(row=>row.stationCode===station.stationCode&&row.bucket===BOARD_TID.CRETURN);
      const summary=cReturnSummary(station.stationCode,day,rows);
      if(summary.Scheduled!==station.board.cReturnTotal||rows.some(row=>row.edd!==day)){
        if(options.requireCReturn)throw new Error('Waiting for dated C-return refresh: '+station.stationCode);
      }else creturn.push(summary);
    }
    const unique=new Map<string,{edd:Set<string>;physical:Set<string>}>();
    for(const station of stations) if(station.board.physicalInventoryCount!==undefined) unique.set(station.stationCode,{edd:new Set(),physical:new Set()});
    for(const row of inventory) {
      const bucket=unique.get(row.stationCode);
      if(!bucket||!row.trackingId) continue;
      if(row.bucket===BOARD_TID.EDD&&row.edd===day) bucket.edd.add(row.trackingId);
      if(row.bucket===BOARD_TID.PHYSICAL) bucket.physical.add(row.trackingId);
    }
    for(const station of stations) {
      const counts=unique.get(station.stationCode);
      if(!counts) throw new Error('Waiting for complete physical inventory refresh: '+station.stationCode);
      stationInventory[station.stationCode]={eddAtStation:counts.edd.size,physicalAtStation:verifiedPhysicalCount(station.board.physicalInventoryCount,counts.physical)};
    }
    stationInventoryTracking.edd=mapBoardTidExportRows(inventory.filter(row=>unique.has(row.stationCode)&&row.bucket===BOARD_TID.EDD&&row.edd===day),"edd");
    stationInventoryTracking.physical=mapBoardTidExportRows(inventory.filter(row=>unique.has(row.stationCode)&&row.bucket===BOARD_TID.PHYSICAL),"dsr-station");
  } catch(error) {
    if(options.requireCReturn || options.maxAgeMinutes===5)throw error;
    // Keep the live DSR available when the package-level inventory endpoint is
    // temporarily unavailable; its two inventory columns will show em dashes.
  }
  return {
    asOf: stamps.sort()[0] || network.asOf,
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
  return {asOf:stamps.sort()[0]||network.asOf,missingStations,dayBuckets:[...AGEING_DAY_BUCKETS],weekBuckets,byStation,trackingIds};
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
    const reminder=slipReminderState(latest,new Date(),30,60,30),submittedAt=submittedRemittanceAt(latest);
    const pending=r.pending&&reminder.due;
    return { asOf, pending, rows: [["Status", r.status], ["Slip uploaded", r.slipUploaded ? "Yes" : "No"], ["Latest remittance", latest?.code||"Not submitted"], ["Remittance submitted", submittedAt?new Date(submittedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" IST":"—"], ["Waiting for slip",submittedAt?`${reminder.elapsedMinutes} minutes`:"—"], ["Reminder",reminder.stage<=1?"First follow-up · 30 minutes":"Repeat follow-up · hourly"], ["Action owner","Station TL"], ["Deposit", r.amount === null ? "—" : money(r.amount)]] };
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
      const alert=reconciliationAlertRows(c.data,day,new Date());
      rows.push(...alert.rows);
      pending ||= Number(alert.rows[0]?.[1]||0)>0;
      if(key==="recon") return {asOf,pending,rows,table:alert.table};
    }
    if (key === "cod" || key === "deposit") {
      const c = s.prepareDeposit;
      if (!c.data || c.state !== "ok") throw new Error("Deposit balance unavailable.");
      fresh(c.checkedAt, day);
      if(key==="deposit") {
        const operations=await prepareDepositOperations(code,day,c.data.actualAmount,new Date());
        rows.push(["Out on road",operations.outOnRoad],["OOR closure",operations.alert.closureAt?new Date(operations.alert.closureAt).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" IST":"Not verified"],["Rule",operations.alert.fullSweep?"10 PM closing sweep · OOR must be zero":"2 hours after OOR reached zero"]);
        pending ||= operations.alert.due;
      } else pending ||= c.data.actualAmount > 0;
      rows.push(["Expected cash",money(c.data.expectedAmount)],["Cash to prepare", money(c.data.actualAmount)],["Difference",money(c.data.variance)]);
    }
    if (key === "cod" || key === "bank") {
      const c = s.remittances;
      if (!c.data || c.state !== "ok") throw new Error("Remittance balance unavailable.");
      fresh(c.checkedAt, day);
      if(key==="bank") {
        const setting=await reportBotDb().from("cod_station_settings").select("pickup_configured,pickup_rule,pickup_window_start,pickup_window_end,next_day_preparation_from").eq("company_id",company).eq("location_id",location).eq("is_active",true).maybeSingle();
        if(setting.error) throw new Error(setting.error.message);
        if(!c.data.complete) throw new Error("Remittance source check is incomplete.");
        const now=new Date();
        if(observedNonPickupWeekday(c.data.rows,s.remittanceWindow,now)) return {asOf,pending:false,rows:[["Status","Recurring non-pickup day · reminder skipped"]]};
        const observed=observedBankerWindow(c.data.rows,now);
        if(!observed) throw new Error("Banker reporting window unavailable: fewer than three days of submitted-remittance last-updated history in the previous seven days.");
        const policy=pickupPolicy({...setting.data,pickup_window_start:observed.start,pickup_window_end:observed.end});
        if(!policy) throw new Error("COD pickup timing is not configured for this station.");
        // A carried balance after a non-pickup day waits for today's CMS window.
        if(now.getTime()<Date.parse(`${day}T${observed.end}:00+05:30`)+30*60000) return {asOf,pending:false,rows:[["Status","Within today's CMS reporting window"]]};
        const overdue=overdueRemittancesAfterGrace(c.data.rows,c.data.latestSubmitted,policy,now,30);
        const overdueAmount=overdue.reduce((sum,item)=>sum+Math.max(0,Number(item.row.expectedAmount)||0),0);
        const bankerVisitAt=Math.max(0,...c.data.rows.filter(row=>row.status.toUpperCase()==="SUBMITTED").map(row=>Number(row.updatedAt)||0));
        const bankerVisitedToday=bankerVisitAt>0&&istDay(new Date(bankerVisitAt))===day;
        rows.push(
          ["CMS usually reports",`${observed.start}–${observed.end} IST`],
          ["Due remittances",`${overdue.length} · ${money(overdueAmount)}`],
          ...(bankerVisitedToday ? [["Submitted today",new Date(bankerVisitAt).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" IST"]] as [string,string][] : []),
          ["Action",bankRemittanceFollowup(bankerVisitedToday)],
        );
        pending ||= overdue.length>0;
      } else {
        rows.push(["Open remittances", c.data.openCount], ["Open amount", money(c.data.openAmount)]);
        pending ||= c.data.openCount > 0;
      }
    }
    return { asOf, pending, rows };
  }
  if (key === "scrub") return loadProgressScrub(company,location,code,day);
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
      rows: [["At station", s.totalCount], ["Overdue", b.overdue], ["Due today", b.dueToday], ["Due tomorrow", b.dueTomorrow], ["Later", b.future], ["EDD unknown", b.unknown], ["Held", b.held || 0]] };
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

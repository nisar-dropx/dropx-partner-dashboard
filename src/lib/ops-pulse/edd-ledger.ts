import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { EddPackage, EddStationResult } from "./edd-worker";
import { eddCurrentState, eddHistoryFacts, eddIstDate, type EddVerification } from "./edd-verification";
import type { PackageHistoryEvent } from "./tracking-lookup";
import { stationEddToday } from "./station-edd";
import { eddSourceSession, eddSourceSummaries, eddSourceHistory } from "./edd-source";

type LedgerRow = { station_code: string; tracking_id: string; source: EddPackage; source_at: string; verification: EddVerification | null; verified_at: string | null };
type LookupObservation = { packageStatus?: string|null; estimatedArrivalTime?: string|null; promisedDeliveryTime?: string|null; driverName?: string|null; driverId?: string|null; lastUpdatedTime?: string|null; history?: PackageHistoryEvent[]; historyComplete?: boolean };
export async function rememberEddLookup(stationCode:string,trackingId:string,body:LookupObservation) {
  if (!supabaseAdmin) return;
  const history = Array.isArray(body.history) ? body.history : [];
  const facts = eddHistoryFacts(history);
  const verification:EddVerification = { state:body.packageStatus||null, edd:eddIstDate(body.estimatedArrivalTime)||eddIstDate(body.promisedDeliveryTime), driverName:body.driverName||null,driverId:body.driverId||null,lastUpdatedAt:body.lastUpdatedTime||null,...facts,
    historyComplete:facts.historyComplete && (body.historyComplete===true || (body.historyComplete==null&&history.length<20)) };
  const now=new Date();
  const {error}=await supabaseAdmin.from("edd_package_ledger").update({verification,verified_at:now.toISOString(),next_check_at:new Date(now.getTime()+(verification.state==="DELIVERED"?7*86400000:2*3600000)).toISOString()}).eq("station_code",stationCode).eq("tracking_id",trackingId);
  if(error)throw new Error(error.message);
}
export async function ingestEddObservations(codes?: string[]) {
  if (!supabaseAdmin) throw new Error("EDD database is not configured.");
  const { error } = await supabaseAdmin.rpc("edd_ingest_observations", { p_codes: codes ?? null });
  if (error) throw new Error(`EDD observation sync failed: ${error.message}`);
}
export async function loadEddLedger(codes: string[]) {
  if (!supabaseAdmin) throw new Error("EDD database is not configured.");
  const result = new Map<string, { packages: EddPackage[]; fetchedAt: string }>();
  if (!codes.length) return result;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.from("edd_package_ledger")
      .select("station_code,tracking_id,source,source_at,verification,verified_at")
      .in("station_code", codes).gte("last_seen_at", new Date(Date.now()-7*86400000).toISOString())
      .order("station_code").order("tracking_id").range(offset,offset+999);
    if (error) throw new Error(`Unable to load verified EDD records: ${error.message}`);
    for (const row of (data ?? []) as LedgerRow[]) {
      if (!codes.includes(row.station_code)) continue;
      const entry = result.get(row.station_code) ?? { packages: [], fetchedAt: row.source_at };
      const pkg = { ...row.source, trackingId: row.tracking_id, sourceAt: row.source_at, verifiedAt: row.verified_at, verification: row.verification };
      pkg.state = eddCurrentState(pkg);
      pkg.driverName ||= row.verification?.driverName;
      if (row.verified_at && row.verified_at >= row.source_at && row.verification?.driverId) {
        pkg.driverId = row.verification.driverId;
        pkg.driverName = row.verification.driverName;
      }
      entry.packages.push(pkg);
      entry.fetchedAt = [entry.fetchedAt,row.source_at,row.verified_at || ""].sort().at(-1)!;
      result.set(row.station_code,entry);
    }
    if (!data || data.length < 1000) break;
  }
  // Names can live on a delivered row whose EDD is not enriched yet. Resolve by
  // exact driver ID across this station's retained records, not just today's cohort.
  for(const entry of result.values()) {
    const names=new Map<string,string>();
    for(const pkg of entry.packages) {
      const id=pkg.driverId?.trim().toUpperCase();
      const name=pkg.driverName?.trim() || pkg.verification?.driverName?.trim();
      if(id && name && name.toUpperCase()!==id)names.set(id,name);
    }
    for(const pkg of entry.packages) {
      const id=pkg.driverId?.trim().toUpperCase();
      if(id && (!pkg.driverName || pkg.driverName.toUpperCase()===id))pkg.driverName=names.get(id)||pkg.driverName;
    }
  }
  return result;
}
export async function loadVerifiedEddStation(stationCode: string): Promise<EddStationResult> {
  const ledger = (await loadEddLedger([stationCode])).get(stationCode);
  if (!ledger) return { status: "no_snapshot", stationCode };
  return { status: "ok", payload: { status: "ok", stationCode, fetchedAt: ledger.fetchedAt, todayYmd: stationEddToday(),
    window: { from: "", to: "" }, totalCount: ledger.packages.length,
    buckets: { overdue: 0, dueToday: 0, dueTomorrow: 0, future: 0, unknown: 0 }, byDate: [],
    packages: ledger.packages, sessionSource: null, accountKey: null } };
}

/** Shared lease, max two upstream histories at once, time-bounded batches.
 * Partial/error history NEVER proves the absence of an earlier attempt. */
export async function verifyEddBatch(codes?: string[]) {
  if (!supabaseAdmin) throw new Error("EDD database is not configured.");
  const base = process.env.EDD_WORKER_URL?.trim().replace(/\/$/, "");
  const key = process.env.EDD_WORKER_ADMIN_KEY?.trim();
  if (!base || !key) throw new Error("Tracking connection is not configured.");
  await ingestEddObservations(codes);
  const token = randomUUID();
  const { data, error } = await supabaseAdmin.rpc("edd_claim_verification", { p_token: token, p_codes: codes ?? null, p_limit: 180 });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as LedgerRow[];
  const byStation=new Map<string,LedgerRow[]>();
  for(const row of rows){const group=byStation.get(row.station_code)??[];group.push(row);byStation.set(row.station_code,group);}
  const groups=[...byStation.values()];
  for(const group of groups)group.sort((a,b)=>Number(!["INDUCTED","RECEIVED"].includes(a.source.state||""))-Number(!["INDUCTED","RECEIVED"].includes(b.source.state||"")));
  const fairRows=Array.from({length:Math.max(0,...groups.map(g=>g.length))},(_,i)=>groups.flatMap(group=>group[i]?[group[i]]:[])).flat();
  rows.splice(0,rows.length,...fairRows);
  let verified = 0, failed = 0, cursor = 0, enriched = 0, enrichmentFailed = 0;
  const deadline = Date.now()+80000;
  const sessions = new Map<string, Awaited<ReturnType<typeof eddSourceSession>> | null>();
  const freshSummaries = new Set<string>();
  const paginationKeys = new Set<string>();
  try {
    // Recover the EDD dates missing from Performance's delivered rows in bulk.
    // The same private source session and read API used by the worker; no passwords.
    let missingQuery=supabaseAdmin.from("edd_package_ledger").select("station_code,tracking_id")
      .is("source->>ead",null).is("verification->>edd",null).is("source->>summaryCheckedAt",null)
      .gte("last_seen_at",new Date(Date.now()-7*86400000).toISOString()).order("station_code").order("tracking_id").limit(4500);
    if(codes)missingQuery=missingQuery.in("station_code",codes);
    const {data:missing}=rows.length ? await missingQuery : {data:[]};
    const idsByCode=new Map<string,string[]>();
    for(const row of [...rows,...(missing??[])]) {
      const ids=idsByCode.get(row.station_code)??[];
      ids.push(row.tracking_id);idsByCode.set(row.station_code,ids);
    }
    const batches=[...idsByCode].flatMap(([code,values])=>{
      const unique=[...new Set(values)];return Array.from({length:Math.ceil(unique.length/300)},(_,i)=>({code,ids:unique.slice(i*300,(i+1)*300)}));
    });
    for (const {code,ids} of batches.slice(0,15)) {
      if (Date.now() > deadline-50000) break;
      const auth = sessions.has(code) ? sessions.get(code) : await eddSourceSession(code).catch(() => null);
      sessions.set(code, auth??null);
      if (!auth) continue;
      if (!ids.length) continue;
      try {
        const observations = await eddSourceSummaries(code,ids,auth);
        const observedAt=new Date().toISOString();
        const values=observations.map(value=>({trackingId:String(value.trackingId),state:value.currentPackageState||null,
          ead: typeof value.estimatedArrivalDate==="number" ? eddIstDate(new Date(value.estimatedArrivalDate).toISOString()) : null,
          promisedDeliveryDate:typeof value.promisedDeliveryDate==="number" ? eddIstDate(new Date(value.promisedDeliveryDate).toISOString()) : null,
          shipOption:value.shipOption||null,summaryCheckedAt:observedAt}));
        const {error:summaryError}=await supabaseAdmin.rpc("edd_apply_summaries",{p_station:code,p_rows:values,p_observed_at:observedAt});
        if(summaryError)throw new Error(summaryError.message);
        enriched+=values.length;
        for(const row of rows.filter(r=>r.station_code===code)) {
          const value=values.find(v=>v.trackingId===row.tracking_id);
          if(value) { row.source={...row.source,...Object.fromEntries(Object.entries(value).filter(([,v])=>v!=null)),ead:row.source.internalEAD||value.ead||row.source.ead};row.source_at=observedAt;freshSummaries.add(`${code}:${row.tracking_id}`); }
        }
      } catch { enrichmentFailed++; }
    }
    await Promise.all([0,1].map(async () => {
      while (cursor < rows.length && Date.now() < deadline) {
        const row = rows[cursor++];
        try {
          const auth=sessions.get(row.station_code);
          if(auth && freshSummaries.has(`${row.station_code}:${row.tracking_id}`)) {
            const result=await eddSourceHistory(row.tracking_id,auth);
            result.paginationKeys.forEach(value=>paginationKeys.add(value));
            const facts=eddHistoryFacts(result.history);
            const verification:EddVerification={state:row.source.state,edd:row.source.ead||null,
              driverName:row.source.driverName||null,driverId:row.source.driverId||null,lastUpdatedAt:row.source_at,
              ...facts,historyComplete:facts.historyComplete&&result.historyComplete};
            const now=new Date();
            const {error:writeError}=await supabaseAdmin!.from("edd_package_ledger").update({verification,verified_at:now.toISOString(),
              next_check_at:new Date(now.getTime()+(verification.state==="DELIVERED"?7*86400000:2*3600000)).toISOString()})
              .eq("station_code",row.station_code).eq("tracking_id",row.tracking_id);
            if(writeError)throw new Error(writeError.message);
            verified++;continue;
          }
          const url = new URL(`${base}/api/admin/executive/edd/lookup`);
          url.searchParams.set("stationCode",row.station_code); url.searchParams.set("trackingId",row.tracking_id);
          const response = await fetch(url,{ headers: { "x-admin-key": key, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
          if (response.status === 429) { failed++; cursor = rows.length; break; }
          if (!response.ok) throw new Error("Tracking source unavailable.");
          const body = await response.json();
          if (body.status !== "ok" || String(body.stationCode || "").toUpperCase() !== row.station_code || String(body.trackingId || "") !== row.tracking_id || !Array.isArray(body.history)) throw new Error("Tracking identity or history could not be verified.");
          const history = body.history.filter((e: unknown): e is PackageHistoryEvent => !!e && typeof e === "object" && typeof (e as PackageHistoryEvent).state === "string");
          const facts = eddHistoryFacts(history);
          const verification: EddVerification = { state: body.packageStatus || null,
            edd: eddIstDate(body.estimatedArrivalTime) || eddIstDate(body.promisedDeliveryTime),
            driverName: body.driverName || null, driverId: body.driverId || null, lastUpdatedAt: body.lastUpdatedTime || null, ...facts,
            // The legacy worker returns at most 20 events without pagination metadata.
            historyComplete: facts.historyComplete && history.length === body.history.length && (body.historyComplete === true || (body.historyComplete == null && history.length < 20)) };
          const now = new Date();
          const { error: writeError } = await supabaseAdmin!.from("edd_package_ledger").update({ verification, verified_at: now.toISOString(),
            next_check_at: new Date(now.getTime()+(verification.state === "DELIVERED" ? 7*86400000 : 2*3600000)).toISOString() })
            .eq("station_code",row.station_code).eq("tracking_id",row.tracking_id);
          if (writeError) throw new Error(writeError.message);
          verified++;
        } catch { failed++; }
      }
    }));
    return { verified, failed, enriched, enrichmentFailed, paginationKeys:[...paginationKeys], checked: verified+failed, busy: rows.length === 0 };
  } finally {
    await supabaseAdmin.from("edd_verification_lease").update({ expires_at: new Date().toISOString(), token: null }).eq("id",1).eq("token",token);
  }
}

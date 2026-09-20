import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { emptyStationReviewTargets, parseStationReviewTargets, type StationReviewTargets } from "./station-review-targets";
export type StationTargetRecord = {stationId:string; targets:StationReviewTargets; version:string};
export const stationTargetCode=(stationId:string)=>`perf_station_review_${stationId}`;

// Reuse the existing configuration master; no rewrite of performance or review records.
export async function loadStationReviewTargets(companyId:string,stationIds:string[]) {
  if(!supabaseAdmin)return {rows:[] as StationTargetRecord[],error:"Station targets are unavailable."};
  if(!stationIds.length)return {rows:[] as StationTargetRecord[],error:null};
  const result=await supabaseAdmin.from("report_import_master").select("source_code,description,updated_at")
    .eq("company_id",companyId).eq("parser_type","performance_station_target").in("source_code",stationIds.map(stationTargetCode));
  if(result.error)return {rows:[] as StationTargetRecord[],error:"Station targets could not be loaded."};
  try {
    const rows=(result.data??[]).map(row=>{
      const value=JSON.parse(row.description||"{}");
      return {stationId:row.source_code.slice("perf_station_review_".length),version:row.updated_at,
        targets:parseStationReviewTargets(value.clearanceCutoff??"",value.emdNoonTarget==null?"":String(value.emdNoonTarget))};
    });
    return {rows:rows as StationTargetRecord[],error:null};
  } catch {return {rows:[] as StationTargetRecord[],error:"Station targets need checking in Performance Master."};}
}
export {emptyStationReviewTargets};

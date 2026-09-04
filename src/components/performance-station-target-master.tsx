"use client";
import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { updateStationReviewTargets } from "@/app/master/performance-targets/actions";
import type { StationTargetRecord } from "@/lib/ops-pulse/station-review-targets-data";

export function PerformanceStationTargetMaster({stations,rows,canEdit,error}:{stations:{id:string;label:string}[];rows:StationTargetRecord[];canEdit:boolean;error:string|null}) {
  const [station,setStation]=useState(stations[0]?.id||"");
  const setting=rows.find(row=>row.stationId===station);
  return <section className="panel review-target-stations">
    <div className="panel-head"><div><h2>Station targets</h2><p className="subtle">Set clearance cutoff and EMD at noon for each station. Blank means not configured.</p></div></div>
    {error?<p role="alert">{error}</p>:null}
    <label>Station<select value={station} onChange={event=>setStation(event.target.value)}>{stations.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <form action={updateStationReviewTargets} key={station+"-"+(setting?.version||"new")} className="review-station-target-form">
      <input type="hidden" name="station_id" value={station}/><input type="hidden" name="version" value={setting?.version||""}/>
      <label>Station clearance cutoff (IST)<input type="time" name="clearance_cutoff" defaultValue={setting?.targets.clearanceCutoff||""}/></label>
      <label>EMD at 12 p.m. target (%)<input name="emd_noon_target" type="number" min="0" max="100" step="0.01" placeholder="Not configured" defaultValue={setting?.targets.emdNoonTarget??""}/><small>At or above this percentage</small></label>
      <SubmitButton disabled={!canEdit||!!error||!station}>Save station targets</SubmitButton>
    </form>
  </section>;
}

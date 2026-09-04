"use client";
import { useState } from "react";
import type { PerformanceConnection } from "@/lib/ops-pulse/performance-review";
import { savePerformanceConnection } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { clearanceVariance } from "@/lib/ops-pulse/station-review-targets";
import {TrendButton} from "@/components/performance-trends";

function clockValue(value:string|null) {
  return value ? new Date(new Date(value).getTime()+330*60000).toISOString().slice(11,16) : "";
}
function persistedConnectionId(id:string|undefined) {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}
export function PerformanceConnections({connections,date,stationCode,canEdit,clearanceCutoff=null}:{
  connections:PerformanceConnection[]; date:string; stationCode:string; canEdit:boolean; clearanceCutoff?:string|null;
}) {
  const [adding,setAdding]=useState(connections.length===0);
  const timingForm=(connection:PerformanceConnection|null,index:number)=> <ReviewActionForm
    key={`${stationCode}-${date}-${connection?.id||"new"}-${connection?.version||0}`}
    action={savePerformanceConnection} className="performance-operations-form review-station-times"
    onSaved={()=>{if(!connection)setAdding(false);}}>
    <input type="hidden" name="source_date" value={date}/>
    <input type="hidden" name="station_code" value={stationCode}/>
    <input type="hidden" name="connection_id" value={persistedConnectionId(connection?.id)}/>
    <input type="hidden" name="version" value={connection?.version??1}/>
    <label>Vehicle / connection<input name="label" maxLength={100} required defaultValue={connection?.label||`Vehicle ${index+1}`}/></label>
    <label>Vehicle arrival<input name="arrival" type="time" required defaultValue={clockValue(connection?.arrival_at??null)}/></label>
    <label>Unloading complete<input name="unloading" type="time" defaultValue={clockValue(connection?.unloading_at??null)}/></label>
    <label>Station clear<input name="clearance" type="time" defaultValue={clockValue(connection?.clearance_at??null)}/></label>
    <button className="button secondary">Save vehicle timings</button>
  </ReviewActionForm>;
  return <section className="review-vehicles" aria-label="Station vehicles">
    <header><span><strong>Station vehicles · {connections.length}</strong><small>{clearanceCutoff ? `Clearance cutoff ${clearanceCutoff} · IST` : "Arrival → unloading → clearance · each vehicle separately"}</small></span>
      {canEdit?<button type="button" className="button secondary" disabled={adding} onClick={()=>setAdding(true)}>+ Add vehicle</button>:null}
    </header>
    <div className="review-vehicle-trends"><span>Arrival <TrendButton group="station" metric="arrival" label="Vehicle arrival"/></span><span>Unloading <TrendButton group="station" metric="unloading" label="Unloading complete"/></span><span>Clearance <TrendButton group="station" metric="clearance" label="Station clearance"/></span></div>
    {connections.map((connection,index)=>{
      const variance=clearanceVariance(connection.clearance_at,date,clearanceCutoff);
      return <details key={connection.id} className="review-vehicle" open={connections.length===1}>
        <summary><span><strong>{connection.label||`Vehicle ${index+1}`}</strong><small>{clockValue(connection.arrival_at)||"—"} → {clockValue(connection.unloading_at)||"—"} → {clockValue(connection.clearance_at)||"—"}</small></span>
          {variance!==null?<span className={variance>0?"review-target-missed":"review-target-met"}>{variance>0?`${variance} min late`:"Within cutoff"}</span>:null}
        </summary>
        {canEdit?timingForm(connection,index):<div className="performance-operations-form review-station-times">
          <label>Vehicle arrival<strong>{clockValue(connection.arrival_at)||"—"}</strong></label><label>Unloading complete<strong>{clockValue(connection.unloading_at)||"—"}</strong></label><label>Station clear<strong>{clockValue(connection.clearance_at)||"—"}</strong></label>
        </div>}
        <small className="review-cod-source">Updated by {connection.updated_by_name || "Station team"}</small>
      </details>;
    })}
    {canEdit&&adding?<div className="review-new-vehicle"><small>Save this vehicle, then use + Add vehicle for the next connection.</small>{timingForm(null,connections.length)}{connections.length?<button type="button" className="button secondary" onClick={()=>setAdding(false)}>Cancel new vehicle</button>:null}</div>:null}
    {!canEdit&&!connections.length?<p>No vehicle timings entered.</p>:null}
  </section>;
}

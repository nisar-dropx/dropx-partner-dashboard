"use client";
import { useState } from "react";
import type { PerformanceConnection } from "@/lib/ops-pulse/performance-review";
import { savePerformanceConnection } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import {TrendButton} from "@/components/performance-trends";

function clockValue(value:string|null) {
  return value ? new Date(new Date(value).getTime()+330*60000).toISOString().slice(11,16) : "";
}
function persistedConnectionId(id:string|undefined) {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}
export function PerformanceConnections({connections,date,stationCode,canEdit}:{
  connections:PerformanceConnection[]; date:string; stationCode:string; canEdit:boolean;
}) {
  const [adding,setAdding]=useState(false);
  const timingForm=(connection:PerformanceConnection|null,index:number)=> <ReviewActionForm
    key={`${stationCode}-${date}-${connection?.id||"new"}-${connection?.version||0}`}
    action={savePerformanceConnection} resetOnSuccess={!connection} className="performance-operations-form review-station-times"
    onSaved={()=>{if(!connection)setAdding(false);}}>
    <input type="hidden" name="source_date" value={date}/>
    <input type="hidden" name="station_code" value={stationCode}/>
    <input type="hidden" name="connection_id" value={persistedConnectionId(connection?.id)}/>
    <input type="hidden" name="version" value={connection?.version??1}/>
    <label>Vehicle / connection<input name="label" maxLength={100} required defaultValue={connection?.label||`Vehicle ${index+1}`}/></label>
    <label>Vehicle arrival<input name="arrival" type="time" required defaultValue={clockValue(connection?.arrival_at??null)}/></label>
    <label>Unloading complete<input name="unloading" type="time" defaultValue={clockValue(connection?.unloading_at??null)}/></label>
    <button className="button secondary">Save vehicle timings</button>
  </ReviewActionForm>;
  return <section className="review-vehicles" aria-label="Station vehicles">
    <header><span><strong>Station vehicles · {connections.length}</strong><small>Arrival & unloading · IST</small></span>
      <div className="review-history-actions"><TrendButton group="station" metric="arrival" label="Vehicle timings and EMD"/>{canEdit?<button type="button" className="button secondary" aria-expanded={adding} aria-controls="review-new-vehicle" onClick={()=>setAdding(v=>!v)}>{adding?"Close new vehicle":"+ Add vehicle"}</button>:null}</div>
    </header>
    {connections.map((connection,index)=>{
      return <ReviewDetails key={connection.id} className="review-vehicle">
        <summary><span><strong>{connection.label||`Vehicle ${index+1}`}</strong><small>Arrived {clockValue(connection.arrival_at)||"—"} · Unloaded {clockValue(connection.unloading_at)||"Not entered"}</small></span><span className="review-expand-label">{canEdit?"Edit timings":"View timings"}</span>
        </summary>
        <ReviewDetailsClose label={`Close ${connection.label||`Vehicle ${index+1}`} timings`}/>
        {canEdit?timingForm(connection,index):<div className="performance-operations-form review-station-times">
          <label>Vehicle arrival<strong>{clockValue(connection.arrival_at)||"—"}</strong></label><label>Unloading complete<strong>{clockValue(connection.unloading_at)||"—"}</strong></label>
        </div>}
        <small className="review-cod-source">Updated by {connection.updated_by_name || "Station team"}</small>
      </ReviewDetails>;
    })}
    {canEdit?<div id="review-new-vehicle" className="review-new-vehicle" hidden={!adding}><small>Add each vehicle separately. Closing keeps your draft until you leave this review.</small>{timingForm(null,connections.length)}</div>:null}
    {!connections.length&&!adding?<p className="review-empty">No vehicle timings entered.{canEdit?" Use + Add vehicle to record arrival and unloading.":""}</p>:null}
  </section>;
}

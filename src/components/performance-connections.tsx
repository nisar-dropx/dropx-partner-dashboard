"use client";

import { useState } from "react";
import type { PerformanceConnection } from "@/lib/ops-pulse/performance-review";
import { savePerformanceConnection } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

function localTime(value:string|null) {
  return value?new Date(new Date(value).getTime()+330*60000).toISOString().slice(0,16):"";
}
function displayTime(value:string|null,date:string) {
  if(!value)return "—";
  const local=localTime(value);
  return `${local.slice(11)}${local.slice(0,10)!==date?` · ${local.slice(8,10)}/${local.slice(5,7)}`:""}`;
}
function persistedConnectionId(id: string | undefined) {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}
function ConnectionForm({ connection,date,stationCode,next,onSaved }: { connection?:PerformanceConnection;date:string;stationCode:string;next:number;onSaved?:()=>void }) {
  return <ReviewActionForm action={savePerformanceConnection} className="review-connection-form" onSaved={onSaved}>
    <input type="hidden" name="source_date" value={date}/><input type="hidden" name="station_code" value={stationCode}/>
    <input type="hidden" name="connection_id" value={persistedConnectionId(connection?.id)}/><input type="hidden" name="version" value={connection?.version??1}/>
    <label>Connection / vehicle<input name="label" maxLength={100} required defaultValue={connection?.label??`Connection ${next}`}/></label>
    <label>Vehicle arrival<input name="arrival" type="datetime-local" required min={`${date}T00:00`} max={`${date}T23:59`} defaultValue={localTime(connection?.arrival_at??null)}/></label>
    <label>Unloading complete<input name="unloading" type="datetime-local" defaultValue={localTime(connection?.unloading_at??null)}/></label>
    <label>Station clearance<input name="clearance" type="datetime-local" defaultValue={localTime(connection?.clearance_at??null)}/></label>
    <button className="button secondary">Save connection</button>
  </ReviewActionForm>;
}
export function PerformanceConnections({ connections,date,stationCode,canEdit }: { connections:PerformanceConnection[];date:string;stationCode:string;canEdit:boolean }) {
  const [adding,setAdding]=useState(false);
  return <section className="review-connections" aria-label="Station connections">
    <header><div><h3>Station connections <small>{connections.length}</small></h3><p>Arrival → unloading → clearance · each vehicle separately</p></div>{canEdit?<button type="button" className="button secondary" onClick={()=>setAdding(!adding)}>{adding?"Cancel":"+ Connection"}</button>:<span className="review-view-only">View only</span>}</header>
    {connections.length?<div className="review-connection-list">{connections.map(connection=><details key={connection.id}>
      <summary><strong>{connection.label}</strong><span><small>Arrival</small>{displayTime(connection.arrival_at,date)}</span><span><small>Unloaded</small>{displayTime(connection.unloading_at,date)}</span><span><small>Cleared</small>{displayTime(connection.clearance_at,date)}</span><em>{canEdit?"Edit":connection.clearance_at?"Cleared":"In progress"}</em></summary>
      {canEdit?<ConnectionForm key={connection.version} connection={connection} date={date} stationCode={stationCode} next={connections.length+1}/>:null}
      <p className="review-connection-audit">Updated by {connection.updated_by_name} · {new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(connection.updated_at))}</p>
    </details>)}</div>:<p className="review-empty">No connections recorded for this date.{canEdit?" Add the first arrival above.":" The station team can add timings here."}</p>}
    {canEdit&&adding?<ConnectionForm key={`new-${connections.length}`} date={date} stationCode={stationCode} next={connections.length+1} onSaved={()=>setAdding(false)}/>:null}
  </section>;
}

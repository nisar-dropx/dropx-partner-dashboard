"use client";
import { useMemo, useState } from "react";
import { dispatchReports, type ReportKey } from "@/lib/report-bot/lm-dispatch-config";
import { saveDispatchRoutes } from "./actions";
import s from "./report-bot.module.css";

export type Schedule = {
  id:string; group_id:string; report:ReportKey; format:string; formats?:string[]; times:string[];
  schedule_start?:string|null; schedule_end?:string|null; interval_minutes?:number|null;
  scope_type?:"station"|"region"; source_location_ids?:string[]; source_region_codes?:string[];
  mentions:string[]; question:string; pending_only:boolean; enabled:boolean;
};
type Group = {id:string; name:string; mode:string; available:boolean};
type Location = {id:string; station_code:string; station_name:string|null; region:string|null; model:string};
const defaults = { start:"07:00", end:"22:00", interval:60 };

export function DispatchForm({groups,locations,schedules,canEdit}:{groups:Group[];locations:Location[];schedules:Schedule[];canEdit:boolean}) {
  const [edit,setEdit] = useState<Schedule|null>(null);
  const [report,setReport] = useState<ReportKey>("edd");
  const [scopeType,setScopeType] = useState<"station"|"region">("station");
  const [selectedGroups,setSelectedGroups] = useState<string[]>([]);
  const [selectedLocations,setSelectedLocations] = useState<string[]>([]);
  const [selectedRegions,setSelectedRegions] = useState<string[]>([]);
  const [formats,setFormats] = useState<string[]>(["text"]);
  const [start,setStart] = useState(defaults.start);
  const [end,setEnd] = useState(defaults.end);
  const [interval,setInterval] = useState(defaults.interval);
  const [groupSearch,setGroupSearch] = useState("");
  const [sourceSearch,setSourceSearch] = useState("");
  const regions = useMemo(()=>[...new Set(locations.map(row=>String(row.region || "").trim()).filter(Boolean))].sort(),[locations]);
  function open(row:Schedule|null) {
    setEdit(row); setGroupSearch(""); setSourceSearch(""); setReport(row?.report || "edd");
    const scope = row?.scope_type || "station"; setScopeType(scope);
    setSelectedGroups(row ? [row.group_id] : []); setSelectedLocations(row?.source_location_ids || []); setSelectedRegions(row?.source_region_codes || []);
    setFormats(row?.formats?.length ? row.formats : row ? [row.format] : ["text"]);
    setStart(row?.schedule_start || defaults.start); setEnd(row?.schedule_end || defaults.end); setInterval(row?.interval_minutes || defaults.interval);
  }
  function toggle(value:string, selected:string[], setter:(next:string[])=>void) { setter(selected.includes(value) ? selected.filter(item=>item!==value) : [...selected,value]); }
  function chooseScope(value:"station"|"region") {
    setScopeType(value);
    if (value === "region") { setSelectedLocations([]); setFormats(["photo","excel"]); }
    else { setSelectedRegions([]); setFormats(["text"]); }
  }
  function chooseReport(value:ReportKey) {
    setReport(value);
  }
  const sourceCount = scopeType === "station" ? selectedLocations.length : selectedRegions.length;
  return <section className={s.card} id="dispatch">
    <header className={s.cardHead}><div><h2>Scheduled WhatsApp reports</h2><p className={s.hint}>Every destination, source, region, schedule and output is read from this Last Mile master. Active locations and regions come from People/location data.</p></div></header>
    {canEdit && <form action={saveDispatchRoutes} key={edit?.id || "new"} className={s.cardBody}>
      <div className={s.formGrid}>
        <label className={s.field}>Report{edit && <input type="hidden" name="report" value={report}/>}<select disabled={Boolean(edit)} className={s.select} name="report" value={report} onChange={e=>chooseReport(e.target.value as ReportKey)}>{Object.entries(dispatchReports).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className={s.field}>Audience scope<select className={s.select} name="scope_type" value={scopeType} onChange={e=>chooseScope(e.target.value as "station"|"region")}><option value="station">Station War Room</option><option value="region">Regional / Internal LM</option></select><small>Destination group is separate from source. This is how XPT can use its configured base-station group.</small></label>
        <div className={s.field}><span>Output</span><div className={s.formActions}>{[["text","TID message"],["photo","Station-count image"],["excel","Excel details"]].map(([value,label])=><label key={value}><input type="checkbox" name="format" value={value} checked={formats.includes(value)} onChange={()=>toggle(value,formats,setFormats)}/> {label}</label>)}</div></div>
        <label className={s.field}>Start time · IST<input className={s.input} type="time" name="schedule_start" value={start} onChange={e=>setStart(e.target.value)} required/></label>
        <label className={s.field}>End time · IST<input className={s.input} type="time" name="schedule_end" value={end} onChange={e=>setEnd(e.target.value)} required/></label>
        <label className={s.field}>Repeat every<input className={s.input} type="number" name="interval_minutes" min={5} max={720} step={5} value={interval} onChange={e=>setInterval(Number(e.target.value))} required/><small>Minutes. The configured window includes both start and end.</small></label>
        <div className={s.field}><label>Destination WhatsApp groups<input className={s.input} type="search" placeholder="Search enabled Last Mile groups" value={groupSearch} onChange={e=>setGroupSearch(e.target.value)}/></label>
          <div style={{maxHeight:150,overflowY:"auto"}}>{groups.filter(g=>g.available && (!edit || edit.group_id === g.id) && g.name.toLowerCase().includes(groupSearch.toLowerCase())).map(g=><label key={g.id} style={{display:"block"}}><input type="checkbox" disabled={Boolean(edit)} checked={selectedGroups.includes(g.id)} onChange={()=>toggle(g.id,selectedGroups,setSelectedGroups)}/> {g.name} · {g.mode}</label>)}</div>
          {selectedGroups.map(id=><input key={id} type="hidden" name="group_id" value={id}/>)}<small>Sending requires the selected group to be enabled, listening and in Live mode.</small>
        </div>
        <div className={s.field}><label>{scopeType === "station" ? "Source stations" : "Source regions"}<input className={s.input} type="search" placeholder={scopeType === "station" ? "Search code, name, region or model" : "Search region"} value={sourceSearch} onChange={e=>setSourceSearch(e.target.value)}/></label>
          <div style={{maxHeight:180,overflowY:"auto"}}>{scopeType === "station" ? locations.filter(row=>`${row.station_code} ${row.station_name || ""} ${row.region || ""} ${row.model}`.toLowerCase().includes(sourceSearch.toLowerCase())).map(row=><label key={row.id} style={{display:"block"}}><input type="checkbox" checked={selectedLocations.includes(row.id)} onChange={()=>toggle(row.id,selectedLocations,setSelectedLocations)}/> {row.station_code}{row.station_name ? ` · ${row.station_name}` : ""}{row.region ? ` · ${row.region}` : ""}{row.model ? ` · ${row.model}` : ""}</label>) : regions.filter(region=>region.toLowerCase().includes(sourceSearch.toLowerCase())).map(region=><label key={region} style={{display:"block"}}><input type="checkbox" checked={selectedRegions.includes(region)} onChange={()=>toggle(region,selectedRegions,setSelectedRegions)}/> {region}</label>)}</div>
          {selectedLocations.map(id=><input key={id} type="hidden" name="source_location_id" value={id}/>)}{selectedRegions.map(region=><input key={region} type="hidden" name="source_region_code" value={region}/>)}
          <small>{scopeType === "station" ? "Select the exact source station(s). The destination can be a different base-station group." : "Membership follows each active location's current region; future master changes apply automatically."}</small>
        </div>
        <label className={s.field}>Follow-up line (optional)<input name="question" maxLength={400} className={s.input} defaultValue={edit?.question}/></label>
        <label className={s.field}>Tag numbers (optional)<input name="mentions" className={s.input} placeholder="Country code + number, separated by commas" defaultValue={edit?.mentions.join(", ")}/></label>
      </div>
      <div className={s.formActions}><label><input type="checkbox" name="pending_only" defaultChecked={edit?.pending_only ?? true}/> Send only while pending</label><label><input type="checkbox" name="enabled" defaultChecked={edit?.enabled ?? true}/> Enabled</label>{edit && <button type="button" className={s.button} onClick={()=>open(null)}>New schedule</button>}<button className={s.primary+" "+s.button} disabled={!selectedGroups.length || !sourceCount || !formats.length}>Save schedule</button></div>
    </form>}
    <div className={s.tableWrap}><table className={s.table}><thead><tr>{["Destination","Report","Source","Window (IST)","Outputs","Status",""].map(value=><th key={value}>{value}</th>)}</tr></thead><tbody>{schedules.map(row=>{
      const source = row.scope_type === "region" ? (row.source_region_codes || []).join(", ") : (row.source_location_ids || []).map(id=>locations.find(location=>location.id===id)?.station_code || "Inactive/missing").join(", ");
      return <tr key={row.id}><td>{groups.find(group=>group.id===row.group_id)?.name || "Group removed"}</td><td>{dispatchReports[row.report]}</td><td>{row.scope_type === "region" ? "Regions: " : "Stations: "}{source || "Legacy mapping"}</td><td>{row.schedule_start && row.schedule_end ? `${row.schedule_start}–${row.schedule_end} · ${row.interval_minutes} min` : row.times.join(", ")}</td><td>{(row.formats?.length ? row.formats : [row.format]).join(" + ")}</td><td>{row.enabled?"Enabled":"Paused"}</td><td>{canEdit && <button className={s.button} onClick={()=>open(row)}>Edit</button>}</td></tr>;
    })}</tbody></table></div>
    {!schedules.length && <p className={s.cardBody}>No outbound schedules configured.</p>}
  </section>;
}

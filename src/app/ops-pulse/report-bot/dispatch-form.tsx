"use client";
import {DEFAULT_DSR_PACE,type DsrPacePoint} from "@/lib/report-bot/lm-dsr-pace";
import { useMemo, useState } from "react";
import { dispatchReports, eodSections, type EodSection, type ReportKey } from "@/lib/report-bot/lm-dispatch-config";
import { saveDispatchRoutes } from "./actions";
import s from "./report-bot.module.css";

export type Schedule = {
  high_value_min_days?:number; high_value_escalation_time?:string; dsr_pace?:DsrPacePoint[]; high_value_summary?:boolean; high_value_threshold?:number;
  id:string; group_id:string; report:ReportKey; format:string; formats?:string[]; times:string[];
  schedule_start?:string|null; schedule_end?:string|null; interval_minutes?:number|null;
  scope_type?:"station"|"region"; source_location_ids?:string[]; source_region_codes?:string[]; source_model_codes?:string[];
  eod_sections?:EodSection[];
  mentions:string[]; question:string; pending_only:boolean; enabled:boolean;
  mention_manager_policy?:"none"|"cluster_then_aom"; mention_designation_codes?:string[]; mention_present_designation_codes?:string[]; mention_latest_shift_designation_codes?:string[];
};
type Group = {id:string; name:string; mode:string; available:boolean};
type Location = {id:string; station_code:string; station_name:string|null; region:string|null; model:string};
type Designation = {code:string; name:string};
const defaults = { start:"07:00", end:"22:00", interval:60 };

export function DispatchForm({groups,locations,designations,schedules,canEdit}:{groups:Group[];locations:Location[];designations:Designation[];schedules:Schedule[];canEdit:boolean}) {
  const [edit,setEdit] = useState<Schedule|null>(null);
  const [report,setReport] = useState<ReportKey>("edd");
  const [scopeType,setScopeType] = useState<"station"|"region">("station");
  const [selectedGroups,setSelectedGroups] = useState<string[]>([]);
  const [selectedLocations,setSelectedLocations] = useState<string[]>([]);
  const [selectedRegions,setSelectedRegions] = useState<string[]>([]);
  const [selectedModels,setSelectedModels] = useState<string[]>([]);
  const [formats,setFormats] = useState<string[]>(["text"]);
  const [selectedEodSections,setSelectedEodSections] = useState<EodSection[]>(["dsr","dot","creturn"]);
  const [start,setStart] = useState(defaults.start);
  const [end,setEnd] = useState(defaults.end);
  const [interval,setInterval] = useState(defaults.interval);
  const [groupSearch,setGroupSearch] = useState("");
  const [sourceSearch,setSourceSearch] = useState("");
  const [managerPolicy,setManagerPolicy] = useState<"none"|"cluster_then_aom">("none");
  const [alwaysDesignations,setAlwaysDesignations] = useState<string[]>([]);
  const [presentDesignations,setPresentDesignations] = useState<string[]>([]);
  const [latestShiftDesignations,setLatestShiftDesignations] = useState<string[]>([]);
  const regions = useMemo(()=>[...new Set(locations.map(row=>String(row.region || "").trim()).filter(Boolean))].sort(),[locations]);
  const models = useMemo(()=>[...new Set(locations.map(row=>String(row.model || "").trim().toUpperCase()).filter(Boolean))].sort(),[locations]);
  function open(row:Schedule|null) {
    setEdit(row); setGroupSearch(""); setSourceSearch(""); setReport(row?.report || "edd");
    const scope = row?.scope_type || "station"; setScopeType(scope);
    setSelectedGroups(row ? [row.group_id] : []); setSelectedLocations(row?.source_location_ids || []); setSelectedRegions(row?.source_region_codes || []); setSelectedModels(row?.source_model_codes || []);
    setFormats(row?.report === "eod" ? ["photo"] : row?.formats?.length ? row.formats : row ? [row.format] : ["text"]);
    setSelectedEodSections(row?.eod_sections?.length ? row.eod_sections : ["dsr","dot","creturn"]);
    setStart(row?.schedule_start || defaults.start); setEnd(row?.schedule_end || defaults.end); setInterval(row?.interval_minutes || defaults.interval);
    setManagerPolicy(row?.mention_manager_policy || "none"); setAlwaysDesignations(row?.mention_designation_codes || []); setPresentDesignations(row?.mention_present_designation_codes || []); setLatestShiftDesignations(row?.mention_latest_shift_designation_codes || []);
  }
  function toggle(value:string, selected:string[], setter:(next:string[])=>void) { setter(selected.includes(value) ? selected.filter(item=>item!==value) : [...selected,value]); }
  function chooseScope(value:"station"|"region") {
    setScopeType(value);
    if (value === "region") { setSelectedLocations([]); setFormats(["photo"]); }
    else { setSelectedRegions([]); setSelectedModels([]); setFormats(report === "eod" ? ["photo"] : ["text"]); }
  }
  function chooseReport(value:ReportKey) {
    setReport(value);
    if(value==='high_value'){setScopeType('station');setFormats(['photo']);setStart('10:30');setEnd('23:00');setInterval(180);}
    if (value === "eod") {
      setScopeType("region"); setSelectedLocations([]); setFormats(["photo"]);
      setStart("23:30"); setEnd("23:30"); setInterval(60);
    }
  }
  const sourceCount = scopeType === "station" ? selectedLocations.length : selectedRegions.length;
  return <section className={s.card} id="dispatch">
    <header className={s.cardHead}><div><h2>Scheduled WhatsApp reports</h2><p className={s.hint}>Every destination, source, region, schedule and output is read from this Last Mile master. Active locations and regions come from People/location data.</p></div></header>
    {canEdit && <form action={saveDispatchRoutes} key={edit?.id || "new"} className={s.cardBody}>
      <div className={s.formGrid}>
        <label className={s.field}>Report{edit && <input type="hidden" name="report" value={report}/>}<select disabled={Boolean(edit)} className={s.select} name="report" value={report} onChange={e=>chooseReport(e.target.value as ReportKey)}>{Object.entries(dispatchReports).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className={s.field}>Audience scope<select className={s.select} name="scope_type" value={scopeType} onChange={e=>chooseScope(e.target.value as "station"|"region")}><option value="station">Station War Room</option><option value="region">Regional / Internal LM</option></select><small>Destination group is separate from source. This is how XPT can use its configured base-station group.</small></label>
        <div className={s.field}><span>Output</span><div className={s.formActions}>{[["text","TID message"],["photo","Compact table image"],["excel","Excel details"]].map(([value,label])=><label key={value}><input type="checkbox" name="format" value={value} disabled={["eod","high_value"].includes(report) && value !== "photo"} checked={formats.includes(value)} onChange={()=>toggle(value,formats,setFormats)}/> {label}</label>)}</div>{report === "eod" ? <small>EOD sends only the compact table images selected below.</small> : null}</div>
        {report === "eod" ? <div className={s.field}><span>EOD sections</span><div className={s.formActions}>{Object.entries(eodSections).map(([value,label])=><label key={value}><input type="checkbox" name="eod_section" value={value} checked={selectedEodSections.includes(value as EodSection)} onChange={()=>toggle(value,selectedEodSections,next=>setSelectedEodSections(next as EodSection[]))}/> {label}</label>)}</div><small>Choose exactly which report images this destination receives.</small></div> : null}
        {report==='dsr'&&<label className={s.field}>Live DSR pace guide<input className={s.input} name="dsr_pace" defaultValue={(edit?.dsr_pace?.length?edit.dsr_pace:DEFAULT_DSR_PACE).map(p=>`${p.time}=${p.target}`).join(', ')}/><small>IST time=target %. Colours compare progress with this guide, not the end-of-day target.</small></label>}
        {report==='high_value'&&<><label className={s.field}>Unresolved / activity days<input className={s.input} type="number" name="high_value_min_days" min="1" max="90" defaultValue={edit?.high_value_min_days||3}/></label><label className={s.field}>Escalation time · IST<input className={s.input} type="time" name="high_value_escalation_time" defaultValue={edit?.high_value_escalation_time||'23:00'}/></label><label className={s.field}>High-value view<select className={s.select} name="high_value_view" defaultValue="detail"><option value="detail">Station · tracking IDs</option></select></label><label className={s.field}>Shipment value at least ₹<input className={s.input} type="number" name="high_value_threshold" min="3000" step="1" defaultValue={edit?.high_value_threshold||5000}/></label><label className={s.field}>Checkpoint times · IST<input className={s.input} name="explicit_times" defaultValue={edit?.times?.join(', ')||'10:30, 23:00'}/><small>War-room exceptions only. Repeated dispatch/attempt scans do not close the case.</small></label></>}
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
          <small>{scopeType === "station" ? "Select the exact source station(s). Use this when one Location Master region must be split into separate report audiences." : "Membership follows each active location's current region; future master changes apply automatically."}</small>
        </div>
        {scopeType === "region" ? <div className={s.field}><span>Source models</span><div style={{maxHeight:150,overflowY:"auto"}}>{models.map(model=><label key={model} style={{display:"block"}}><input type="checkbox" checked={selectedModels.includes(model)} onChange={()=>toggle(model,selectedModels,setSelectedModels)}/> {model}</label>)}</div>{selectedModels.map(model=><input key={model} type="hidden" name="source_model_code" value={model}/>)}<small>Model scope comes from the location master. EOD requires at least one model, so client programmes are never mixed accidentally.</small></div> : null}
        <label className={s.field}>Follow-up line (optional)<input name="question" maxLength={400} className={s.input} defaultValue={edit?.question}/></label>
        <label className={s.field}>Tag numbers (optional)<input name="mentions" className={s.input} placeholder="Country code + number, separated by commas" defaultValue={edit?.mentions.join(", ")}/></label>
        <label className={s.field}>Station manager tags<select name="mention_manager_policy" className={s.select} value={managerPolicy} onChange={event=>setManagerPolicy(event.target.value as "none"|"cluster_then_aom")}><option value="none">No automatic manager tag</option><option value="cluster_then_aom">Always Cluster Manager; otherwise AOM</option></select><small>People is the source of truth. Manager tagging is never dependent on attendance.</small></label>
        <div className={s.field}><span>Role tags</span><div style={{maxHeight:150,overflowY:"auto"}}>{designations.map(row=><label key={row.code} style={{display:"block"}}><input type="checkbox" name="mention_designation_code" value={row.code} checked={alwaysDesignations.includes(row.code)} onChange={()=>toggle(row.code,alwaysDesignations,setAlwaysDesignations)}/> {row.code} · {row.name}</label>)}</div><small>Selected active People roles are tagged whether or not they have a station punch. Use for Control Tower and Head of Last Mile.</small></div>
        <div className={s.field}><span>Present team tags</span><div style={{maxHeight:150,overflowY:"auto"}}>{designations.map(row=><label key={row.code} style={{display:"block"}}><input type="checkbox" name="mention_present_designation_code" value={row.code} checked={presentDesignations.includes(row.code)} onChange={()=>toggle(row.code,presentDesignations,setPresentDesignations)}/> {row.code} · {row.name}</label>)}</div><small>Selected roles are tagged only when their latest punch today is a biometric In at this station and there is no later Out. For EDD, select TL and SSA.</small></div>
        <div className={s.field}><span>Latest shift team tags</span><div style={{maxHeight:150,overflowY:"auto"}}>{designations.map(row=><label key={row.code} style={{display:"block"}}><input type="checkbox" name="mention_latest_shift_designation_code" value={row.code} checked={latestShiftDesignations.includes(row.code)} onChange={()=>toggle(row.code,latestShiftDesignations,setLatestShiftDesignations)}/> {row.code} · {row.name}</label>)}</div><small>Tags people who are currently present or worked the station's latest shift today, even after punching Out. Use this for closing-shift SSA accountability.</small></div>
      </div>
      <div className={s.formActions}><label><input type="checkbox" name="pending_only" defaultChecked={edit?.pending_only ?? true}/> Send only while pending</label><label><input type="checkbox" name="enabled" defaultChecked={edit?.enabled ?? true}/> Enabled</label>{edit && <button type="button" className={s.button} onClick={()=>open(null)}>New schedule</button>}<button className={s.primary+" "+s.button} disabled={!selectedGroups.length || !sourceCount || !formats.length || (report === "eod" && (!selectedEodSections.length || (scopeType === "region" && !selectedModels.length)))}>Save schedule</button></div>
    </form>}
    <div className={s.tableWrap}><table className={s.table}><thead><tr>{["Destination","Report","Source","Window (IST)","Outputs","Automatic tags","Status",""].map(value=><th key={value}>{value}</th>)}</tr></thead><tbody>{schedules.map(row=>{
      const source = row.scope_type === "region" ? (row.source_region_codes || []).join(", ") : (row.source_location_ids || []).map(id=>locations.find(location=>location.id===id)?.station_code || "Inactive/missing").join(", ");
      const modelScope = row.scope_type === "region" && row.source_model_codes?.length ? ` · Models: ${row.source_model_codes.join(", ")}` : "";
      const tags=[row.mention_manager_policy==="cluster_then_aom"?"CLM → AOM":null,(row.mention_designation_codes||[]).join(", ")||null,(row.mention_present_designation_codes||[]).length?`Present: ${row.mention_present_designation_codes!.join(", ")}`:null,(row.mention_latest_shift_designation_codes||[]).length?`Latest shift: ${row.mention_latest_shift_designation_codes!.join(", ")}`:null].filter(Boolean).join(" · ");
      const outputs=row.report==="eod" ? (row.eod_sections?.length?row.eod_sections:["dsr","dot","creturn"]).map(section=>eodSections[section as EodSection]).join(" + ") : (row.formats?.length ? row.formats : [row.format]).join(" + ");
      return <tr key={row.id}><td>{groups.find(group=>group.id===row.group_id)?.name || "Group removed"}</td><td>{dispatchReports[row.report]}</td><td>{row.scope_type === "region" ? "Regions: " : "Stations: "}{source || "Legacy mapping"}{modelScope}</td><td>{row.schedule_start && row.schedule_end ? `${row.schedule_start}–${row.schedule_end} · ${row.interval_minutes} min` : row.times.join(", ")}</td><td>{outputs}</td><td>{tags||"—"}</td><td>{row.enabled?"Enabled":"Paused"}</td><td>{canEdit && <button className={s.button} onClick={()=>open(row)}>Edit</button>}</td></tr>;
    })}</tbody></table></div>
    {!schedules.length && <p className={s.cardBody}>No outbound schedules configured.</p>}
  </section>;
}

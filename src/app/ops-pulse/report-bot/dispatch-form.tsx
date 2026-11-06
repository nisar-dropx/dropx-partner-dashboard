"use client";
import { useState } from "react";
import { dispatchReports, suggestedTimes, type ReportKey } from "@/lib/report-bot/lm-dispatch-config";
import { saveDispatchRoutes } from "./actions";
import s from "./report-bot.module.css";

export type Schedule = { id:string; group_id:string; report:ReportKey; format:string; times:string[]; mentions:string[]; question:string; pending_only:boolean; enabled:boolean };
type Group = {id:string; name:string; mode:string; mapped:boolean};
export function DispatchForm({groups,schedules,canEdit}:{groups:Group[];schedules:Schedule[];canEdit:boolean}) {
  const [edit,setEdit] = useState<Schedule|null>(null);
  const [report,setReport] = useState<ReportKey>("edd");
  const [times,setTimes] = useState(suggestedTimes("edd").join(", "));
  const [selected,setSelected] = useState<string[]>([]);
  const [search,setSearch] = useState("");
  function open(row:Schedule|null) {
    setEdit(row); setSelected(row ? [row.group_id] : []); setSearch("");
    setReport(row?.report || "edd"); setTimes((row?.times || suggestedTimes("edd")).join(", "));
  }
  return <section className={s.card} id="dispatch">
    <header className={s.cardHead}><h2>Scheduled WhatsApp reports</h2></header>
    {canEdit && <form action={saveDispatchRoutes} key={edit?.id || "new"} className={s.cardBody}>
      <div className={s.formGrid}>
        <label className={s.field}>Report{edit && <input type="hidden" name="report" value={report}/>}<select disabled={Boolean(edit)} className={s.select} name="report" value={report} onChange={e=>{const key=e.target.value as ReportKey; setReport(key);setTimes(suggestedTimes(key).join(", "));}}>{Object.entries(dispatchReports).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className={s.field}>Format<select className={s.select} name="format" defaultValue={edit?.format || "text"}><option value="text">Text summary</option><option value="photo">Photo table</option><option value="table">Tab-separated data</option></select></label>
        <label className={s.field}>Daily send times · IST<input className={s.input} name="times" required value={times} onChange={e=>setTimes(e.target.value)} placeholder="10:00, 17:00"/></label>
        <div className={s.field}><label>Destination groups<input className={s.input} type="search" placeholder="Search mapped groups" value={search} onChange={e=>setSearch(e.target.value)}/></label>
          <div style={{maxHeight:130,overflowY:"auto"}}>{groups.filter(g=>g.mapped && (!edit || edit.group_id === g.id) && g.name.toLowerCase().includes(search.toLowerCase())).map(g=><label key={g.id} style={{display:"block"}}><input type="checkbox" disabled={Boolean(edit)} checked={selected.includes(g.id)} onChange={e=>setSelected(ids=>e.target.checked ? [...ids,g.id] : ids.filter(id=>id!==g.id))}/> {g.name} · {g.mode}</label>)}</div>
          {selected.map(id=><input key={id} type="hidden" name="group_id" value={id}/>)}<small>Map stations in Groups. Sending requires Live mode.</small>
        </div>
        <label className={s.field}>Follow-up question (optional)<input name="question" maxLength={400} className={s.input} defaultValue={edit?.question}/></label>
        <label className={s.field}>Tag numbers (optional)<input name="mentions" className={s.input} placeholder="Country code + number, separated by commas" defaultValue={edit?.mentions.join(", ")}/></label>
      </div>
      <div className={s.formActions}><label><input type="checkbox" name="pending_only" defaultChecked={edit?.pending_only}/> Only when pending</label><label><input type="checkbox" name="enabled" defaultChecked={edit?.enabled ?? true}/> Enabled</label>
      {edit && <button type="button" className={s.button} onClick={()=>open(null)}>New schedule</button>}
      <button className={s.primary+" "+s.button} disabled={!selected.length}>Save schedule</button></div>
    </form>}
    <div className={s.tableWrap}><table className={s.table}><thead><tr>{["Group","Report","Times (IST)","Format","Status",""].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{schedules.map(r=><tr key={r.id}><td>{groups.find(g=>g.id===r.group_id)?.name || "Group removed"}</td><td>{dispatchReports[r.report]}</td><td>{r.times.join(", ")}</td><td>{r.format}</td><td>{r.enabled?"Enabled":"Paused"}</td><td>{canEdit && <button className={s.button} onClick={()=>open(r)}>Edit</button>}</td></tr>)}</tbody></table></div>
    {!schedules.length && <p className={s.cardBody}>No outbound schedules configured.</p>}
  </section>;
}

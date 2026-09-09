"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatDashboardDate } from "@/lib/date-format";
import { reviewClock, type UtrDiscipline } from "@/lib/ops-pulse/review-operations";
import { historyPeriodDays, historyStatusLabels, summarizeAttendance, type AttendancePeriod, type ReviewAttendanceHistory } from "@/lib/ops-pulse/review-attendance-history";

type HistoryContext = { data: ReviewAttendanceHistory | null; date: string; error: string | null; retry: () => void };
const History = createContext<HistoryContext | null>(null);
const hours = (value: number | null) => value == null ? "—" : `${Math.floor(value / 60)}h ${Math.round(value % 60)}m`;

/** A single request is shared by every person link and card in this review. */
export function ReviewAttendanceProvider({ station, date, children }: { station: string; date: string; children: ReactNode }) {
  const [result, setResult] = useState<{key:string;data:ReviewAttendanceHistory|null;error:string|null} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${station}:${date}`;
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    const query = new URLSearchParams({ station, date });
    fetch(`/api/ops-pulse/performance/attendance-history?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw Error("Attendance history could not be loaded.");
        const data = await response.json() as ReviewAttendanceHistory;
        if (data.station !== station || data.date !== date || !Array.isArray(data.people)) throw Error("Attendance history did not match this review.");
        if (!controller.signal.aborted) setResult({key,data,error:null});
      })
      .catch(error => { if (!controller.signal.aborted) setResult({key,data:null,error:error.message}); });
    return () => controller.abort();
  }, [station, date, key, attempt]);
  return <History.Provider value={{date,data:result?.key===key?result.data:null,error:result?.key===key?result.error:null,retry:()=>setAttempt(v=>v+1)}}>{children}</History.Provider>;
}

function HistoryState() {
  const history = useContext(History);
  return <p className="review-attendance-state" role={history?.error ? "alert" : "status"}>{history?.error ?? "Loading attendance history…"}{history?.error ? <> <button type="button" className="review-attendance-button" onClick={history.retry}>Retry</button></> : null}</p>;
}

function PeriodSwitch({ value, onChange }: { value: AttendancePeriod; onChange: (value: AttendancePeriod) => void }) {
  return <div className="review-attendance-period" role="group" aria-label="Attendance period">
    <button type="button" aria-pressed={value==="7d"} onClick={()=>onChange("7d")}>Last 7 days</button>
    <button type="button" aria-pressed={value==="mtd"} onClick={()=>onChange("mtd")}>MTD</button>
  </div>;
}

export function ReviewPersonHistory({ personId }: { personId: string }) {
  const history = useContext(History);
  const [period, setPeriod] = useState<AttendancePeriod>("mtd");
  if (!history?.data) return <HistoryState/>;
  const person = history.data.people.find(p=>p.id===personId);
  if (!person) return <p className="review-attendance-state">This person is not in the selected station’s People attendance list.</p>;
  const days = historyPeriodDays(person,history.date,period), counts = summarizeAttendance(days);
  return <section className="review-person-history" aria-label={`${person.name} attendance history`}>
    <header className="review-attendance-toolbar"><div><b>{person.name}</b><small>{person.role} · {person.code} · through {formatDashboardDate(history.date)}</small></div><PeriodSwitch value={period} onChange={setPeriod}/></header>
    <div className="review-operation-summary"><span className={counts.repeated?"review-operation-pending":""}><b>{counts.late}/{counts.reported}</b> reported shifts late</span><span>Unplanned absence <b>{counts.unplanned}</b></span><span>Week-off worked <b>{counts.weekOffWorked}</b></span>{counts.unchecked ? <span>Needs checking <b>{counts.unchecked}</b></span>:null}</div>
    {counts.repeated ? <p className="review-repeat-note">{counts.allReportedLate ? "Late on every reported shift in this period." : `Repeated lateness · ${counts.late} days in this period.`} Flag starts at 2 late days; approved shift grace is respected.</p> : null}
    <div className="review-operation-table review-person-history-table" role="region" aria-label={`${person.name} daily in and out, scroll for all dates`} tabIndex={0}>
      <table><thead><tr><th>Date</th><th>Shift</th><th>In</th><th>Out</th><th>Worked</th><th>Status / detail</th></tr></thead><tbody>
        {[...days].reverse().map(day=><tr key={day.date}><th scope="row">{formatDashboardDate(day.date)}</th><td>{day.shift??"—"}</td><td>{reviewClock(day.inTime)}</td><td>{day.outTime?reviewClock(day.outTime):day.inTime?"Missing out":"—"}</td><td>{hours(day.workMinutes)}</td><td><b className={["late","unplanned_absence"].includes(day.status)?"review-operation-pending":""}>{historyStatusLabels[day.status]}{day.status==="late"?` · ${day.lateMinutes} min`:""}</b><small>{day.note}</small></td></tr>)}
      </tbody></table>
    </div>
    <p className="review-operation-note">All times IST. Only service dates at this station are shown. “Reported shifts” excludes leave, roster-off and missing-shift days. Missing punches are not proof of leave; worked hours are not pay or overtime approval.</p>
  </section>;
}

export function ReviewPersonHistoryLink({ personId, label = "View 7-day / MTD attendance" }: { personId: string; label?: string }) {
  const [open,setOpen] = useState(false);
  return <div className="review-person-inline"><button type="button" className="review-person-link" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{label}<span aria-hidden="true"> {open?"▴":"›"}</span></button>{open?<ReviewPersonHistory personId={personId}/>:null}</div>;
}

export function UtrRepeatSummary() {
  const history=useContext(History);
  if (!history?.data) return null;
  const repeated=history.data.people.filter(person=>summarizeAttendance(historyPeriodDays(person,history.date,"mtd")).repeated).length;
  return repeated ? <small className="review-repeat-summary">{repeated} repeated-late staff · MTD</small> : null;
}

export function UtrAttendanceDrilldown({ discipline: d }: { discipline: UtrDiscipline }) {
  const history = useContext(History);
  const [personId,setPersonId] = useState<string|null>(null);
  const [period,setPeriod] = useState<AttendancePeriod>("mtd");
  const [query,setQuery] = useState("");
  const [filter,setFilter] = useState("all");
  const [sort,setSort] = useState("late");
  if (personId) return <><button type="button" className="review-attendance-button" onClick={()=>setPersonId(null)}>← All UTR staff</button><ReviewPersonHistory key={personId} personId={personId}/></>;
  const items = d.rows.map(row=>{
    const person=history?.data?.people.find(p=>p.id===row.id);
    return {row,counts:person&&history?summarizeAttendance(historyPeriodDays(person,history.date,period)):null};
  }).filter(({row,counts})=>(`${row.name} ${row.code} ${row.role}`.toLowerCase().includes(query.trim().toLowerCase())) && (filter==="all" || filter==="repeat"&&counts?.repeated || filter==="late"&&row.status===`${row.lateMinutes} min late`))
    .sort((a,b)=>sort==="name"?a.row.name.localeCompare(b.row.name):(b.counts?.late??-1)-(a.counts?.late??-1) || a.row.name.localeCompare(b.row.name));
  const repeated=items.filter(i=>i.counts?.repeated).length;
  return <>
    <div className="review-attendance-toolbar"><div><b>{history?.data?`${repeated} repeated-late staff in view`:"Reporting patterns"}</b><small>Click a person for daily attendance · repeat flag from 2 late days</small></div><PeriodSwitch value={period} onChange={setPeriod}/></div>
    <div className="review-attendance-filters"><input aria-label="Search UTR staff" type="search" placeholder="Search name, code or role" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Filter UTR reporting" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All staff</option><option value="repeat">Repeated lateness</option><option value="late">Late on review day</option></select><select aria-label="Sort UTR staff" value={sort} onChange={e=>setSort(e.target.value)}><option value="late">Most late days first</option><option value="name">Name A–Z</option></select>{history?.data?<button type="button" className="review-attendance-button" onClick={history.retry}>Refresh history</button>:null}</div>
    {!history?.data?<HistoryState/>:null}
    <div className="review-operation-table review-utr-table" role="region" aria-label="UTR staff attendance, scroll for all people and columns" tabIndex={0}>
      <table><thead><tr><th>Person / role</th><th>Shift</th><th>Reported</th><th>Left</th><th>Worked</th><th>Review day</th><th>{period==="mtd"?"MTD":"7-day"} pattern</th></tr></thead><tbody>
        {items.map(({row,counts})=><tr key={row.id}><th scope="row"><button type="button" className="review-person-link" onClick={()=>setPersonId(row.id)}>{row.name} ›</button><small>{row.role} · {row.code}</small></th><td>{row.shift||"Not linked"}</td><td>{reviewClock(row.inTime)}</td><td>{row.outTime?reviewClock(row.outTime):row.inTime?"Missing out":"—"}</td><td>{hours(row.workMinutes)}</td><td>{row.status}{row.locationNote?<small>{row.locationNote}</small>:null}</td><td>{counts?<><button type="button" onClick={()=>setPersonId(row.id)} aria-label={`${row.name}: ${counts.late} of ${counts.reported} reported shifts late — view history`} className={`review-person-link ${counts.repeated?"review-repeat-badge":""}`}>Late {counts.late}/{counts.reported} reported</button>{counts.allReportedLate?<small>Every reported shift late</small>:null}</>:"—"}</td></tr>)}
        {!items.length?<tr><td colSpan={7}>{d.rows.length?"No staff match these filters.":"No station People staff found."}</td></tr>:null}
      </tbody></table>
    </div>
  </>;
}

export function ReviewAttendanceExceptionsCard() {
  const history=useContext(History), [personId,setPersonId]=useState<string|null>(null), [filter,setFilter]=useState("all");
  const items=history?.data?.people.flatMap(person=>{const day=person.days.find(d=>d.date===history.date);return day&&["unplanned_absence","absence_unconfirmed","attendance_conflict","week_off_worked","leave_pending"].includes(day.status)?[{person,day}]:[];})??[];
  const absence=items.filter(i=>i.day.status==="unplanned_absence").length, worked=items.filter(i=>i.day.status==="week_off_worked").length;
  const unchecked=items.filter(i=>["absence_unconfirmed","attendance_conflict"].includes(i.day.status)).length;
  const pending=items.filter(i=>i.day.status==="leave_pending").length;
  return <details className={`performance-fact-card review-operation-card review-attendance-exceptions ${absence?"late":""}`} name="performance-review-fact">
    <summary aria-label="Unplanned leave and week-off work — view staff details"><span>Unplanned leave / week-off work</span><strong>{history?.data?`${absence} unplanned absence · ${worked} worked on week-off`:history?.error?"Data unavailable":"Checking attendance…"}</strong><small>{history?.data?`${unchecked} need punch checks · ${pending} leave applications pending · selected review day`:"Verified roster, leave applications and attendance"}</small></summary>
    <div className="review-operation-popover">
      <header><div><b>Attendance exceptions · {history?formatDashboardDate(history.date):""}</b><p>Selected review day · People staff</p></div></header>
      {!history?.data?<HistoryState/>:personId?<><button type="button" className="review-attendance-button" onClick={()=>setPersonId(null)}>← Attendance exceptions</button><ReviewPersonHistory key={personId} personId={personId}/></>:<>
        <div className="review-attendance-filters"><label>Show <select aria-label="Filter attendance exceptions" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All exceptions</option><option value="unplanned_absence">Unplanned absence</option><option value="week_off_worked">Worked on week-off</option><option value="check">Needs checking</option><option value="leave_pending">Leave requested</option></select></label></div>
        <div className="review-operation-table review-utr-table" role="region" aria-label="Attendance exceptions, scroll for all staff" tabIndex={0}><table><thead><tr><th>Person / role</th><th>Status</th><th>In / out</th><th>Worked</th></tr></thead><tbody>
          {items.filter(i=>filter==="all"||i.day.status===filter||filter==="check"&&["absence_unconfirmed","attendance_conflict"].includes(i.day.status)).map(({person,day})=><tr key={person.id}><th scope="row"><button type="button" className="review-person-link" onClick={()=>setPersonId(person.id)}>{person.name} ›</button><small>{person.role} · {person.code}</small></th><td>{historyStatusLabels[day.status]}<small>{day.note}</small></td><td>{reviewClock(day.inTime)} / {reviewClock(day.outTime)}</td><td>{hours(day.workMinutes)}</td></tr>)}
          {!items.some(i=>filter==="all"||i.day.status===filter||filter==="check"&&["absence_unconfirmed","attendance_conflict"].includes(i.day.status))?<tr><td colSpan={4}>No matching attendance exceptions.</td></tr>:null}
        </tbody></table></div>
        <p className="review-operation-note">Unplanned absence requires a recorded absence after a scheduled shift ends, without an active leave application. Missing punches alone stay under “Needs checking”. A week-off punch does not authorize overtime. Click any person for 7-day / MTD details.</p>
      </>}
    </div>
  </details>;
}

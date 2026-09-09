import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { CodLocationRow } from "./cod";
import { loadReviewUtrDiscipline } from "./review-operations-data";
import { attendanceHistoryDates, classifyAttendanceDay, type ReviewAttendanceHistory } from "./review-attendance-history";

type Shift = { name: string; start_time: string; end_time: string; grace_in_minutes: number | null };
type Plan = { id: string; roster_kind: string; effective_from: string; superseded_at: string | null; revision_no: number | null; location_id?: string | null; hr_roster_plan_locations?: {location_id:string}[] };
type Roster = { plan_id: string; worker_type: string; worker_id: string; roster_date: string; day_type: string; hr_shifts: Shift | Shift[] | null; hr_roster_plans?: Plan | Plan[] | null };
type Profile = { id: string; biometric_id: string | null; location_id: string | null; date_of_join: string | null; last_working_date: string | null };
type Attendance = { id: string; punch_date: string; employee_id: string | null; contractor_id: string | null; worker_type: string | null; enrolment_id: string; in_time: string | null; out_time: string | null; work_minutes: number | null; punch_count: number | null; status: string | null };
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] ?? null : value ?? null;
const bioKey = (value: string | null | undefined) => (value ?? "").trim().replace(/^0+(?=\d)/, "");
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: {message:string} | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset=0; offset<20000; offset+=1000) {
    const result = await query(offset, offset+999);
    if (result.error) throw Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw Error("Attendance history is too large to verify safely.");
}

/** One bounded station/month read, not one full-company manpower request per day. */
export async function loadReviewAttendanceHistory(companyId: string, station: CodLocationRow, date: string): Promise<ReviewAttendanceHistory> {
  if (!supabaseAdmin) throw Error("Attendance service unavailable.");
  const db = supabaseAdmin, dates = attendanceHistoryDates(date), from = dates[0];
  const staff = await loadReviewUtrDiscipline(companyId, station, date);
  if (staff.error) throw Error(staff.error);
  if (!staff.discipline.rows.length) return {station:station.station_code,date,people:[]};
  if (staff.discipline.rows.length > 300) throw Error("Too many staff for one station history.");
  const employeeIds = staff.discipline.rows.filter(p=>p.id.startsWith("employee:")).map(p=>p.id.slice(9));
  const contractorIds = staff.discipline.rows.filter(p=>p.id.startsWith("contractor:")).map(p=>p.id.slice(11));
  const ids = [...employeeIds, ...contractorIds];
  const workerFilters = [employeeIds.length ? `employee_id.in.(${employeeIds.join(",")})` : "", contractorIds.length ? `contractor_id.in.(${contractorIds.join(",")})` : ""].filter(Boolean).join(",");
  const [employees, contractors, engagements, plans, dated, leaves] = await Promise.all([
    employeeIds.length ? all<Profile>((a,b)=>db.from("employees").select("id,biometric_id,location_id,date_of_join,last_working_date").eq("company_id",companyId).in("id",employeeIds).order("id").range(a,b)) : [],
    contractorIds.length ? all<Profile>((a,b)=>db.from("contractors").select("id,biometric_id,location_id,date_of_join,last_working_date").eq("company_id",companyId).in("id",contractorIds).order("id").range(a,b)) : [],
    all((a,b)=>db.from("hr_engagements").select("id,worker_type,employee_id,contractor_id,start_date,end_date").eq("company_id",companyId).or(workerFilters).lte("start_date",date).or(`end_date.is.null,end_date.gte.${from}`).order("id").range(a,b)),
    all<Plan>((a,b)=>db.from("hr_roster_plans").select("id,roster_kind,effective_from,superseded_at,revision_no,location_id,hr_roster_plan_locations(location_id)").eq("company_id",companyId).eq("status","approved").eq("roster_kind","recurring_weekly").lte("effective_from",date).or(`superseded_at.is.null,superseded_at.gt.${from}`).order("id").range(a,b)),
    all<Roster>((a,b)=>db.from("hr_roster_entries").select("plan_id,worker_type,worker_id,roster_date,day_type,hr_shifts(name,start_time,end_time,grace_in_minutes),hr_roster_plans!inner(id,roster_kind,effective_from,superseded_at,revision_no)").eq("company_id",companyId).in("worker_id",ids).gte("roster_date",from).lte("roster_date",date).eq("hr_roster_plans.status","approved").eq("hr_roster_plans.roster_kind","dated").order("id").range(a,b)),
    all((a,b)=>db.from("hr_leave_requests").select("employee_id,contractor_id,start_date,end_date,status").eq("company_id",companyId).or(workerFilters).lte("start_date",date).gte("end_date",from).order("id").range(a,b))
  ]);
  const profiles = new Map<string, Profile>([...employees.map(p=>[`employee:${p.id}`,p] as const), ...contractors.map(p=>[`contractor:${p.id}`,p] as const)]);
  const bioPeople = new Map<string,string[]>();
  for (const [id,p] of profiles) { const key = `${id.split(":")[0]}:${bioKey(p.biometric_id)}`; bioPeople.set(key,[...(bioPeople.get(key)??[]),id]); }
  const enrolments = [...new Set([...profiles.values()].flatMap(p=>{const k=bioKey(p.biometric_id);return k ? [p.biometric_id!.trim(),k,k.padStart(6,"0"),k.padStart(8,"0")] : [];}))];
  if (enrolments.some(id=>! /^[A-Za-z0-9_-]+$/.test(id))) throw Error("A staff attendance identifier needs checking.");
  const attendanceFilters = [workerFilters, enrolments.length ? `enrolment_id.in.(${enrolments.join(",")})` : ""].filter(Boolean).join(",");
  const scopedPlans = plans.filter(p=>p.location_id===station.id || p.hr_roster_plan_locations?.some(l=>l.location_id===station.id) || (!p.location_id && !p.hr_roster_plan_locations?.length));
  const planMap = new Map(scopedPlans.map(p=>[p.id,p]));
  const [attendance, weekly, assignments, rawPunches] = await Promise.all([
    all<Attendance>((a,b)=>db.from("attendance_daily").select("id,punch_date,employee_id,contractor_id,worker_type,enrolment_id,in_time,out_time,work_minutes,punch_count,status").eq("company_id",companyId).gte("punch_date",from).lte("punch_date",date).neq("status","U").or(attendanceFilters).order("id").range(a,b)),
    scopedPlans.length ? all<Roster>((a,b)=>db.from("hr_roster_entries").select("plan_id,worker_type,worker_id,roster_date,day_type,hr_shifts(name,start_time,end_time,grace_in_minutes)").eq("company_id",companyId).in("worker_id",ids).in("plan_id",scopedPlans.map(p=>p.id)).order("id").range(a,b)) : [],
    engagements.length ? all((a,b)=>db.from("hr_work_assignments").select("engagement_id,location_id,effective_from,effective_to").eq("company_id",companyId).eq("is_primary",true).in("engagement_id",engagements.map(e=>e.id)).lte("effective_from",date).or(`effective_to.is.null,effective_to.gte.${from}`).order("effective_from",{ascending:false}).order("id").range(a,b)) : [],
    enrolments.length ? all((a,b)=>db.from("attendance_punches").select("enrolment_id,punch_date").eq("company_id",companyId).gte("punch_date",from).lte("punch_date",date).in("enrolment_id",enrolments).order("id").range(a,b)) : []
  ]);
  // Raw activity protects against an absent aggregate awaiting synchronization.
  // It never manufactures an in/out time or attributes ambiguous week-off work.
  const rawActivity = new Set(rawPunches.map(p=>`${bioKey(p.enrolment_id)}:${p.punch_date}`));
  const biometricOwners = new Map<string, number>();
  for (const profile of profiles.values()) { const key=bioKey(profile.biometric_id); if(key) biometricOwners.set(key,(biometricOwners.get(key)??0)+1); }
  const attendanceMap = new Map<string,Attendance[]>();
  for (const row of attendance) {
    const type = row.worker_type === "employee" ? "employee" : row.worker_type === "individual_contract" || (row.worker_type === "contractor" && row.contractor_id) ? "contractor" : null;
    if (!type) continue;
    const workerId = type === "employee" ? row.employee_id : row.contractor_id;
    const matches = bioPeople.get(`${type}:${bioKey(row.enrolment_id)}`) ?? [];
    const id = workerId ? `${type}:${workerId}` : matches.length === 1 ? matches[0] : null;
    if (!id || !profiles.has(id)) continue;
    const key = `${id}:${row.punch_date}`; attendanceMap.set(key,[...(attendanceMap.get(key)??[]),row]);
  }
  const roster = [...dated, ...weekly.map(row=>({...row,hr_roster_plans:planMap.get(row.plan_id)}))];
  const now = new Date();
  return { station: station.station_code, date, people: staff.discipline.rows.map(person=>({ id:person.id,name:person.name,code:person.code,role:person.role,
    days: dates.map(day=>{
      const [type,id] = person.id.split(":"), profile=profiles.get(person.id);
      const personEngagements = engagements.filter(e=>(type==="employee"?e.employee_id:e.contractor_id)===id && e.worker_type===type);
      const activeEngagements = personEngagements.filter(e=>e.start_date<=day && (!e.end_date||e.end_date>=day));
      const personAssignments = assignments.filter(a=>personEngagements.some(e=>e.id===a.engagement_id));
      const assignment = personAssignments.find(a=>activeEngagements.some(e=>e.id===a.engagement_id) && a.effective_from<=day && (!a.effective_to||a.effective_to>=day));
      const inScope = Boolean(profile && (!profile.date_of_join||profile.date_of_join<=day) && (!profile.last_working_date||profile.last_working_date>=day)
        && (!personEngagements.length||activeEngagements.length) && (!personAssignments.length||assignment)
        && (assignment?.location_id??profile.location_id)===station.id);
      const candidates = roster.filter(r=>{
        const p=one(r.hr_roster_plans); return r.worker_type===type && r.worker_id===id && p && (!p.effective_from||p.effective_from<=day) && (!p.superseded_at||day<p.superseded_at)
          && (p.roster_kind==="dated" ? r.roster_date===day : weekday(r.roster_date)===weekday(day));
      }).sort((a,b)=>{const x=one(a.hr_roster_plans)!,y=one(b.hr_roster_plans)!;return Number(y.roster_kind==="dated")-Number(x.roster_kind==="dated") || Number(y.revision_no??0)-Number(x.revision_no??0) || String(y.effective_from??"").localeCompare(String(x.effective_from??""));});
      const selected=candidates[0], shift=selected?.day_type==="working"?one(selected.hr_shifts):null;
      const records=attendanceMap.get(`${person.id}:${day}`)??[];
      // Multiple aggregates cannot manufacture an absence; prefer actual in/out evidence.
      const record=[...records].sort((a,b)=>Number(Boolean(b.in_time))-Number(Boolean(a.in_time)) || Number(b.punch_count??0)-Number(a.punch_count??0))[0];
      const applied=leaves.filter(l=>(type==="employee"?l.employee_id:l.contractor_id)===id && l.start_date<=day && l.end_date>=day);
      const rawRecorded = rawActivity.has(`${bioKey(profile?.biometric_id)}:${day}`);
      const ambiguousPunch = rawRecorded && (biometricOwners.get(bioKey(profile?.biometric_id))??0)>1 && !record?.in_time;
      return classifyAttendanceDay({date:day,inScope,dayType:selected?.day_type??null,shift:shift?`${shift.name} · ${shift.start_time.slice(0,5)}–${shift.end_time.slice(0,5)}`:null,
        start:shift?.start_time??null,end:shift?.end_time??null,grace:Number(shift?.grace_in_minutes??0),inTime:record?.in_time??null,outTime:record?.out_time??null,
        workMinutes:record?.work_minutes??null,punchCount:Math.max(rawRecorded ? 1 : 0,...records.map(r=>r.punch_count??0)),ambiguousPunch,
        rawActivityOnly:rawRecorded && !records.some(r=>r.in_time||r.out_time||r.punch_count),attendanceStatus:record?.status??null,
        approvedLeave:applied.some(l=>l.status==="approved"),requestedLeave:applied.some(l=>!["cancelled","rejected","draft"].includes(l.status))},now);
    }) })) };
}

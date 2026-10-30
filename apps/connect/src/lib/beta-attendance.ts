import type { SupabaseClient } from '@supabase/supabase-js';

type Daily = {punch_date:string;in_time:string|null;out_time:string|null;updated_at:string|null;status:string|null};
type Punch = {punch_date:string;punch_time:string;punch_label:string|null;created_at:string;source:string|null;calculated:boolean|null;worker_status:string|null};
export type BetaAttendance = Daily & {source:'processed'|'device_receipt';reviewRequired:boolean};

/** Device receipt is evidence of a punch, never approval for attendance/payroll. */
export function betaAttendanceEvidence(daily:Daily|null,punches:Punch[],since:string,now=Date.now()):BetaAttendance|null {
  const start=Date.parse(since);
  if(!Number.isFinite(start))return null;
  const valid=(t:string|null)=>Boolean(t)&&Number.isFinite(Date.parse(t!))&&Date.parse(t!)>=start&&Date.parse(t!)<=now;
  const raw=punches.filter(p=>p.source==='biometric'&&valid(p.punch_time)).sort((a,b)=>a.punch_time.localeCompare(b.punch_time));
  const latest=raw.at(-1);
  if(daily&&(valid(daily.in_time)||valid(daily.out_time))&&(!latest||daily.punch_date>=latest.punch_date)) {
    return {...daily,source:'processed',reviewRequired:/review|unmapped|duplicate|inactive/i.test(daily.status??'')};
  }
  if(!latest)return null;
  const day=raw.filter(p=>p.punch_date===latest.punch_date);
  return {punch_date:latest.punch_date,in_time:day.find(p=>/^in\d*$/i.test(p.punch_label??''))?.punch_time??null,
    out_time:day.filter(p=>/^out\d*$/i.test(p.punch_label??'')).at(-1)?.punch_time??null,
    updated_at:day.map(p=>p.created_at).sort().at(-1)??null,status:'Review',source:'device_receipt',reviewRequired:true};
}

export async function loadBetaAttendance(db:SupabaseClient,company:string,biometricId:string|null,since:string) {
  if(!biometricId||!Number.isFinite(Date.parse(since)))return {data:null,error:'Biometric identity unavailable'};
  const now=new Date().toISOString();
  const [daily,latest]=await Promise.all([
    db.from('attendance_daily').select('punch_date,in_time,out_time,status,updated_at').eq('company_id',company).eq('enrolment_id',biometricId).gte('punch_date',since.slice(0,10)).order('punch_date',{ascending:false}).limit(1).maybeSingle(),
    db.from('attendance_punches').select('punch_date').eq('company_id',company).eq('enrolment_id',biometricId).eq('source','biometric').gte('punch_time',since).lte('punch_time',now).order('punch_time',{ascending:false}).limit(1).maybeSingle()
  ]);
  const punches=latest.data?await db.from('attendance_punches').select('punch_date,punch_time,punch_label,created_at,source,calculated,worker_status').eq('company_id',company).eq('enrolment_id',biometricId).eq('source','biometric').eq('punch_date',latest.data.punch_date).gte('punch_time',since).lte('punch_time',now).order('punch_time',{ascending:false}).limit(100):{data:[],error:null};
  return {data:betaAttendanceEvidence(daily.data,punches.data??[],since,Date.parse(now)),error:daily.error||latest.error||punches.error};
}

/** A bounded calendar-month view of this pilot's biometric evidence only. */
export async function loadBetaAttendanceMonth(db:SupabaseClient,company:string,biometricId:string|null,since:string,month:string) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!biometricId||!Number.isFinite(Date.parse(since)))throw new Error('Attendance identity or month unavailable');
  const start=`${month}-01`, end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)).toISOString().slice(0,10);
  const [daily,punches]=await Promise.all([
    db.from('attendance_daily').select('punch_date,in_time,out_time,status,updated_at').eq('company_id',company).eq('enrolment_id',biometricId).gte('punch_date',start).lt('punch_date',end).order('punch_date',{ascending:false}).limit(32),
    db.from('attendance_punches').select('punch_date,punch_time,punch_label,created_at,source,calculated,worker_status').eq('company_id',company).eq('enrolment_id',biometricId).eq('source','biometric').gte('punch_date',start).lt('punch_date',end).gte('punch_time',since).lte('punch_time',new Date().toISOString()).order('punch_time',{ascending:false}).limit(3001)
  ]);
  if(daily.error||punches.error)throw new Error('Attendance could not be refreshed. Try again.');
  const dates=[...new Set([...(daily.data??[]),...(punches.data??[])].map(p=>p.punch_date))].sort().reverse();
  return {days:dates.map(date=>betaAttendanceEvidence(daily.data?.find(p=>p.punch_date===date)??null,(punches.data??[]).filter(p=>p.punch_date===date),since)).filter((p):p is BetaAttendance=>Boolean(p)),truncated:(punches.data?.length??0)>3000};
}

/** Device setup is cumulative. A receipt proves enrolment, not a paid attendance day. */
export function hasBetaSetupPunches(punches:Pick<Punch,'punch_time'|'punch_label'|'source'>[],since:string,now=Date.now()) {
 const start=Date.parse(since);if(!Number.isFinite(start))return false;
 return punches.some(p=>p.source==='biometric'&&/^(in|out)\d*$/i.test(p.punch_label??'')&&Number.isFinite(Date.parse(p.punch_time))&&Date.parse(p.punch_time)>=start&&Date.parse(p.punch_time)<=now);
}
export async function loadBetaSetupPunches(db:SupabaseClient,company:string,biometricId:string|null,since:string) {
 if(!biometricId||!Number.isFinite(Date.parse(since)))return false;
 const result=await db.from('attendance_punches').select('punch_time,punch_label,source').eq('company_id',company).eq('enrolment_id',biometricId).eq('source','biometric').gte('punch_time',since).lte('punch_time',new Date().toISOString()).order('punch_time',{ascending:true}).limit(100);
 return !result.error&&hasBetaSetupPunches(result.data??[],since);
}

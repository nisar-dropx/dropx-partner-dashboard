export type ActivityShift = {
  shift_date: string; shift_slot: string; status: string;
  outgoing_user_id?: string | null; outgoing_name?: string | null;
  incoming_name?: string | null; updated_at?: string;
};
export type ActivityDay = { work_date: string; status: string; owner_name?: string | null; updated_at?: string };
export type ActivitySummary = {
  slots: { slot: string; person: string; submitted: boolean; due: boolean; pct: number | null; handover: string; repeat: string }[];
  submitted: number; expected: number; accepted: number; awaiting: number;
  store: { submitted: boolean; person: string; pct: number | null };
  trend: string; history: string; attention: boolean;
};
const sent = (s: {status:string}) => ['submitted','accepted'].includes(s.status);
const priorDay = (d: string, n: number) => { const date = new Date(d+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+n); return date.toISOString().slice(0,10); };
/** Daily totals use D−1 only. History describes recorded reports, never an inferred employee absence. */
export function summarizeActivity<S extends ActivityShift,D extends ActivityDay>(input: {
  date: string; slots: string[]; shifts: S[]; days: D[];
  isDue: (date:string,slot:string)=>boolean;
  shiftPct: (row:S)=>number; storePct: (row:D)=>number;
}): ActivitySummary {
  const {date,slots,isDue,shiftPct,storePct} = input;
  const shifts = input.shifts.filter(s=>s.status!=='cancelled' && s.shift_date<=date && s.shift_date>=priorDay(date,-6));
  const days = input.days.filter(d=>d.status!=='cancelled' && d.work_date<=date && d.work_date>=priorDay(date,-6));
  const latest = <T extends {updated_at?:string}>(rows:T[]) => [...rows].sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||''))[0];
  const dayRows = slots.map(slot=>({slot,row:latest(shifts.filter(s=>s.shift_date===date && s.shift_slot===slot))}));
  const slotRows = dayRows.map(({slot,row})=> {
    const due = isDue(date,slot);
    const recorded = row ? shifts.filter(s=>row.outgoing_user_id ? s.outgoing_user_id===row.outgoing_user_id : s.outgoing_name===row.outgoing_name && Boolean(row.outgoing_name)).filter(s=>isDue(s.shift_date,s.shift_slot)) : [];
    const missed = recorded.filter(s=>!sent(s)).length;
    return {slot,person:row?.outgoing_name || 'SI not recorded — check roster',submitted:Boolean(row && sent(row)),due,
      pct:row ? shiftPct(row) : null, handover:row?.status==='accepted'?'Accepted':row?.status==='submitted'?`Awaiting ${row.incoming_name || 'incoming SI'}`:row?.status==='rejected'?'Returned':'—',
      repeat:missed>=2 ? `${missed}/${recorded.length} recorded shifts not submitted · 7d` : ''};
  });
  const expected = slotRows.filter(s=>s.due).length, submitted=slotRows.filter(s=>s.due && s.submitted).length;
  const previous = priorDay(date,-1);
  const previousRows = slots.map(slot=>latest(shifts.filter(s=>s.shift_date===previous && s.shift_slot===slot)));
  const previousCount = previousRows.filter(s=>s && sent(s)).length;
  const d = latest(days.filter(d=>d.work_date===date));
  const unfinishedDays = new Set(days.filter(d=>d.status!=='submitted').map(d=>d.work_date)).size;
  const history = unfinishedDays ? `${unfinishedDays} recorded store day${unfinishedDays===1?'':'s'} not submitted · 7d` : days.length ? 'Recorded store reports submitted · 7d' : 'No store reports recorded · 7d';
  return {slots:slotRows,submitted,expected,accepted:dayRows.filter(({row})=>row?.status==='accepted').length,
    awaiting:dayRows.filter(({row})=>row?.status==='submitted').length,
    store:{submitted:d?.status==='submitted',person:d?.owner_name || 'Owner not recorded',pct:d?storePct(d):null},
    trend:previousRows.some(Boolean) ? `D−2: ${previousCount}/${slots.length} submitted · ${submitted-previousCount>0?'+':''}${submitted-previousCount} reports` : 'D−2: no reports recorded',
    history,attention:submitted<expected || d?.status!=='submitted' || dayRows.some(({row})=>row?.status==='submitted')};
}

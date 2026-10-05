export type AdhocHistoryRequest = { id: string; work_date: string; status: string | null; approval_status: string | null; amount_approved: number | string | null; amount: number | string | null; amount_requested: number | string | null };
export type AdhocHistoryDay = {date: string; count: number; amount: number; pending: number; missingAmounts: number};
export function historyWindow(today: string) {
  const day = new Date(`${today}T00:00:00Z`);
  const before = (n: number) => new Date(day.getTime()-n*86400000).toISOString().slice(0,10);
  const sevenFrom=before(7), monthFrom=today.slice(0,7)+'-01';
  return {sevenFrom,monthFrom,from:sevenFrom < monthFrom ? sevenFrom : monthFrom,through:before(1)};
}
export function summarizeAdhocHistory(rows: AdhocHistoryRequest[], today: string, excludedId: string) {
  const window = historyWindow(today);
  const days = new Map<string,AdhocHistoryDay>();
  for(const row of new Map(rows.map(row=>[row.id,row])).values()) {
    if(row.id===excludedId || row.work_date<window.from || row.work_date>window.through) continue;
    const states=[row.status,row.approval_status].map(state=>(state??'').trim().toUpperCase());
    if(states.some(state=>['DRAFT','REJECTED','RETURNED','CANCELLED','CANCELED'].includes(state))) continue;
    if(!states.some(state=>['PENDING','RE_PENDING','SUBMITTED','RESUBMITTED','APPROVED','PROCESSING','PROCESSED','PAID'].includes(state)||state.endsWith('_APPROVED'))) continue;
    const day=days.get(row.work_date)??{date:row.work_date,count:0,amount:0,pending:0,missingAmounts:0};
    const value=row.amount_approved??row.amount??row.amount_requested;
    const amount=value==null || value==='' ? null : Number(value);
    day.count++;
    if(amount==null || !Number.isFinite(amount) || amount<0) day.missingAmounts++;
    else day.amount+=amount;
    if(!states.some(state=>['APPROVED','PROCESSING','PROCESSED','PAID'].includes(state))) day.pending++;
    days.set(day.date,day);
  }
  const sorted=[...days.values()].sort((a,b)=>b.date.localeCompare(a.date));
  const sum=(from:string)=>sorted.filter(row=>row.date>=from).reduce((out,row)=>({count:out.count+row.count,amount:out.amount+row.amount,pending:out.pending+row.pending,missingAmounts:out.missingAmounts+row.missingAmounts}),{count:0,amount:0,pending:0,missingAmounts:0});
  return {...window,days:sorted,seven:sum(window.sevenFrom),mtd:sum(window.monthFrom)};
}
export type AdhocHistory = ReturnType<typeof summarizeAdhocHistory> & {station:string};

import type {Entry,EntryDetail} from './model';
type Row=Record<string,any>;
const money=(n:unknown)=>{const value=Number(n);if(!Number.isFinite(value))throw Error('Invalid operating cost.');return Math.round(value*100);};
export function finalApproval(r:Row){
 const status=String(r.status??'').toUpperCase(),approval=String(r.approval_status??'').toUpperCase();
 if([status,approval].some(s=>['REJECTED','RETURNED','CANCELLED'].includes(s)))return false;
 return [status,approval].some(s=>['FINAL_APPROVED','PROCESSING','PROCESSED','PAID'].includes(s))||([status,approval].some(s=>['APPROVED','RE_APPROVED'].includes(s))&&!r.current_approver_user_id&&!r.current_approver_role_id&&!r.current_approver_role_ids?.length);
}
/** CPS owns expense recognition/deduplication. Attach request evidence only when it reconciles exactly. */
export function operatingCosts(month:string,breakup:Row[],periods:Row[],payments:Row[],stations:Row[]){
 const costs=new Map<string,Entry>(),dayRows=new Map<string,Row[]>();let heldCosts=0,pendingFleet=0,unresolvedPaymentDays=0;
 const stationById=new Map(stations.map(s=>[s.id,s.station_code]));
 const candidates:Row[]=payments.filter(finalApproval).map(r=>({...r,station:stationById.get(r.location_id)||String(r.station_code||r.location_code||'').trim().toUpperCase(),label:(Array.isArray(r.payment_heads)?r.payment_heads[0]:r.payment_heads)?.name}));
 for(const r of breakup){
  if(['Shipment payment mapping','CPS Inputs'].includes(r.source))continue;
  if(r.source==='Fleet Vehicle Master'&&/PENDING-/i.test(r.sub_head??''))pendingFleet++;
  if(/salary|payroll|associate payout|helper payout|employee payout/i.test(r.sub_head??'')){heldCosts++;continue;}
  const id=`cost:${JSON.stringify([r.station_code,r.source,r.head,r.sub_head])}`,n=money(r.amount);
  const entry=costs.get(id);
  if(entry)entry.paise+=n;
  else costs.set(id,{id,month,station:r.station_code,sourceStation:r.station_code,side:'expense',head:r.sub_head||r.head,description:r.source==='Finance Rent Master'?'Contract rent and maintenance for this month':`${r.sub_head||r.head} · recorded operating expenses`,paise:n,source:r.source,reference:`${r.source} / ${month}`,date:`${month}-${String(new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()).padStart(2,'0')}`,details:[]});
  const key=JSON.stringify([id,r.work_date]),list=dayRows.get(key)??[];list.push(r);dayRows.set(key,list);
 }
 for(const [key,rows] of dayRows){
  const [id,date]=JSON.parse(key),entry=costs.get(id)!,r=rows[0],total=rows.reduce((n,row)=>n+money(row.amount),0);
  let detail:EntryDetail[]=[];
  const monthly=periods.filter(p=>p.station_code===r.station_code&&p.label===r.sub_head&&(p.source==='payment'?'Approved payment requests':'Cashbook')===r.source&&p.period_from<=date&&p.period_to>=date);
  if(monthly.length)detail=monthly.map(p=>{const days=(Date.parse(p.period_to)-Date.parse(p.period_from))/86400000+1,index=(Date.parse(date)-Date.parse(p.period_from))/86400000+1,amount=money(p.amount);return {date,paise:Math.round(amount*index/days)-Math.round(amount*(index-1)/days),reference:p.reference||p.source_id,label:`${p.label} · billing ${p.period_from} to ${p.period_to}${p.confirmed?'':' · period unconfirmed'}`};});
  else if(r.source==='Approved payment requests')detail=candidates.filter(p=>p.station===r.station_code&&p.label===r.sub_head&&p.work_date===date).map(p=>({date,paise:money(p.amount_approved??p.amount??p.amount_requested??0),reference:p.request_no||p.id,label:`${p.label} · ${p.status||p.approval_status}`}));
  if(!detail.length||detail.reduce((n,d)=>n+d.paise,0)!==total){
   if(r.source==='Approved payment requests')unresolvedPaymentDays++;
   detail=[{date,paise:total,reference:r.source,label:r.source==='Approved payment requests'?'Recognised daily total · individual request evidence requires review':`${r.sub_head||r.head} · ${r.source==='Fleet Vehicle Master'||r.source==='Finance Rent Master'?'daily accrual':'daily source total'}`}];
  }
  entry.details!.push(...detail);
 }
 for(const e of costs.values())e.details!.sort((a,b)=>a.date.localeCompare(b.date)||a.reference.localeCompare(b.reference));
 return {costs,heldCosts,pendingFleet,unresolvedPaymentDays};
}

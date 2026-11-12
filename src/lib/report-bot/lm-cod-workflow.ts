import {approximateJourney} from './lm-cod-return-fallback.ts';
import type { CodRemittance, CodStatusSnapshot } from '../ops-pulse/cod-status';
import type { PickupPolicy } from '../ops-pulse/cod-pickup';

export const codDay=(at:number)=>new Date(at+330*60000).toISOString().slice(0,10);
export const codClock=(at:number|null)=>at?new Date(at).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}):'Unavailable';
export const codMoney=(n:number)=>'₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2});
export const cashOpen=(r:CodRemittance)=>['CREATED','PENDING_SUBMISSION'].includes(r.status.toUpperCase());
export const submittedTime=(r:CodRemittance)=>r.status.toUpperCase()==='SUBMITTED'?(r.submittedAt||r.updatedAt||null):null;
export type Journey={driverId:string;lastStopAt:number|null;distanceKm:number|null;travelMinutes:number|null;returnAt:number|null;dueAt:number|null;closed:boolean;basis:string};
export type CashObservation={at:number;prepare:number;remittances:CodRemittance[];drivers:Array<{id:string;name:string;amount:number;dueAt:number|null;lastStopAt:number|null;closed:boolean;packages?:Array<{id:string;amount:number}>}>};
export type CodSection={key:string;title:string;columns:string[];rows:Array<Array<string|number>>;action:string;owner:'team'|'tl';tone:'attention'|'waiting'};

/** Submission time is only a pickup proxy. Late edits cannot prove physical handover. */
export function pickupReview(before:CashObservation|undefined,after:CashObservation,pickupAt:number) {
 if(!before||before.at>=pickupAt||pickupAt-before.at>45*60000||after.at<pickupAt) return null;
 const already=new Set(before.remittances.filter(r=>submittedTime(r)).map(r=>r.id));
 const submissions=after.remittances.filter(r=>{const at=submittedTime(r);return at!==null&&at>before.at&&at<=after.at&&!already.has(r.id);});
 if(!Number.isFinite(before.prepare)||before.prepare<0||before.remittances.filter(cashOpen).some(r=>!Number.isFinite(r.actualAmount)||r.actualAmount<0))return null;
 if(!submissions.length||submissions.some(r=>!Number.isFinite(r.actualAmount)||r.actualAmount<0)) return null;
 const prepared=before.remittances.filter(cashOpen).reduce((n,r)=>n+Math.max(0,r.actualAmount),0);
 const available=Math.round((before.prepare+prepared)*100)/100;
 const deposited=Math.round(submissions.reduce((n,r)=>n+r.actualAmount,0)*100)/100;
 // This is a measured ledger gap, not a claim about physical possession/theft.
 const gap=Math.max(0,Math.round((available-deposited)*100)/100);
 const lateDas=before.drivers.flatMap(d=>{
  if(d.amount<=0||!d.closed||d.dueAt===null||d.dueAt>pickupAt)return [];
  const current=after.drivers.find(x=>x.id===d.id);
  if(!current||!d.packages?.length||!current.packages?.length)return [];
  const ids=new Set(current.packages.map(p=>p.id));
  const amount=d.packages.filter(p=>ids.has(p.id)).reduce((n,p)=>n+p.amount,0);
  return amount>0?[{...d,amount:Math.min(d.amount,current.amount,amount)}]:[];
 });
 return {available,deposited,gap,lateDas,beforeAt:before.at,pickupAt,codes:submissions.map(r=>r.code||r.id)};
}

/** A new daytime remittance after pickup at a next-day station is not overdue.
 * Earlier still-open rows require comparison, not an assumption they were cleared. */
export function dueBankRows(rows:CodRemittance[],policy:PickupPolicy,now:number) {
 const submitted=rows.map(submittedTime).filter((t):t is number=>t!==null&&t<=now);
 const latest=Math.max(0,...submitted);
 const minutes=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
 return rows.filter(cashOpen).flatMap(row=>{
  const created=row.createdAt;
  if(!created||created>now)return [];
  let day=codDay(created);
  const clock=new Date(created+330*60000).toISOString().slice(11,16);
  if(latest>=created)return []; // post-pickup evidence review handles these separately
  if(policy.rule==='Next Day') {
   if((latest>0&&codDay(latest)===day&&created>latest)||minutes(clock)>=minutes(policy.preparationFrom||policy.start)) day=codDay(Date.parse(day+'T00:00:00+05:30')+86400000);
  } else if(policy.rule==='Same Day-Partial'&&minutes(clock)>minutes(policy.end)) day=codDay(Date.parse(day+'T00:00:00+05:30')+86400000);
  const dueAt=Date.parse(`${day}T${policy.end}:00+05:30`);
  return now>=dueAt+30*60000?[{row,dueAt}]:[];
 });
}

export function prepareTrigger(input:{amount:number;oor:number|null;reconPending:number;closedSince:number|null;policy:PickupPolicy|null;submittedToday:boolean;nonPickup:boolean;now:number}) {
 const {amount,oor,reconPending,closedSince,policy,submittedToday,nonPickup,now}=input;
 if(!Number.isFinite(amount)||amount<=0)return null;
 const day=codDay(now),clock=new Date(now+330*60000).toISOString().slice(11,16);
 // An applicable upcoming pickup can include partial cash while routes continue.
 if(policy&&!nonPickup&&!submittedToday) {
  const start=Date.parse(`${day}T${policy.start}:00+05:30`),end=Date.parse(`${day}T${policy.end}:00+05:30`);
  if(now>=start-30*60000&&now<=end)return 'pickup' as const;
 }
 // Day-end preparation is only after the complete COD cycle, not just zero OOR.
 if(oor===0&&reconPending<=0&&clock>='19:00'&&(clock>='22:00'||(closedSince!==null&&now-closedSince>=120*60000)))return 'closure' as const;
 return null;
}

export function evidenceFromSnapshot(s:CodStatusSnapshot,journeys:Map<string,Journey>):CashObservation|null {
 const r=s.reconciliation,p=s.prepareDeposit,m=s.remittances;
 if(r.state!=='ok'||!r.data?.complete||p.state!=='ok'||!p.data||p.data.sourceScope!=='outstanding_history'||p.data.sourceWindow?.startTime!==0||m.state!=='ok'||!m.data?.complete)return null;
 const stamps=[r.checkedAt,p.checkedAt,m.checkedAt].map(Date.parse);
 if(stamps.some(n=>!Number.isFinite(n))||Math.max(...stamps)-Math.min(...stamps)>5*60000||!Number.isFinite(p.data.actualAmount)||p.data.actualAmount<0)return null;
 return {at:Math.max(...stamps),prepare:p.data.actualAmount,remittances:m.data.rows,drivers:r.data.drivers.filter(d=>d.pendingAmount>0).map(d=>({id:d.id,name:d.name,amount:d.pendingAmount,dueAt:approximateJourney(journeys.get(d.id))?null:journeys.get(d.id)?.dueAt??null,lastStopAt:journeys.get(d.id)?.lastStopAt??null,closed:journeys.get(d.id)?.closed??false,packages:d.packages.map(p=>({id:p.trackingId,amount:p.amount}))}))};
}

/** Explicit, bounded hold. No free-text AI can silently mark cash resolved. */
export function parseCodHold(text:string,station:string,messageAt:number,now:number) {
 const match=/^COD HOLD\s+([A-Z0-9]+)\s+(RECON|PREPARE|BANK|PICKUP|SLIP|SHORT)\s+UNTIL\s+([0-2]\d:[0-5]\d)\s+(.{8,300})$/i.exec(text.trim());
 if(!match||match[1].toUpperCase()!==station.toUpperCase()||match[3]>'23:59')return null;
 const until=Date.parse(`${codDay(messageAt)}T${match[3]}:00+05:30`);
 if(until<=now||until<=messageAt||until-messageAt>4*3600000)return null;
 return {key:match[2].toLowerCase(),until,reason:match[4]};
}

/** Date attribution requires evidence; a morning aggregate alone has no collection date. */
export function prepareCarryover(before:CashObservation|undefined,amount:number,rows:CodRemittance[],day:string) {
 if(!before||codDay(before.at)!==codDay(Date.parse(day+'T00:00:00+05:30')-1)||amount<=0||before.prepare+0.01<amount)return false;
 return !rows.some(row=>(row.createdAt==null||row.createdAt>before.at)||((submittedTime(row)||0)>before.at));
}
export function prepareAction(amount:number,pickup:boolean,carryover:boolean) {
 return `${carryover?"Yesterday’s reconciled cash is still awaiting preparation. ":""}Click Prepare Deposit now for ${codMoney(amount)}.${pickup?' Include it in this CMS pickup.':''} Reminders continue until completed.`;
}

export function priorDayCash(packages:Array<{collectedAt?:number|null;amount:number}>,day:string) {
 const dated=packages.filter(pkg=>typeof pkg.collectedAt==='number'&&Number.isFinite(pkg.collectedAt)&&pkg.collectedAt>0&&codDay(pkg.collectedAt)<day);
 return {amount:dated.reduce((sum,pkg)=>sum+Math.max(0,pkg.amount),0),dates:[...new Set(dated.map(pkg=>codDay(pkg.collectedAt!)))].sort().join(', ')};
}
export function shouldAlertPreparation(trigger:unknown,slot:string,carryover:boolean){return Boolean(trigger)&&(slot>='12:00'||carryover);}

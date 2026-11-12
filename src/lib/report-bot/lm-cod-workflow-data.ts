import {approximateJourney} from './lm-cod-return-fallback';
import 'server-only';
import {loadCodExceptions} from '../ops-pulse/cod-exceptions';
import {trackCodShortfalls} from './lm-cod-shortfalls';
import {reportBotDb} from './settings';
import {fetchCodStatus} from '../ops-pulse/cash-recon-worker';
import {fetchLoadFlashBoard} from '../ops-pulse/edd-worker';
import {pickupPolicy} from '../ops-pulse/cod-pickup';
import {loadCodPendingReport} from '../ops-pulse/cod-pending-data';
import {hasSlipProof} from '../ops-pulse/cod-pending';
import {observedBankerWindow,observedNonPickupWeekday} from './lm-cod-alerts';
import {codDay,codClock,codMoney,submittedTime,dueBankRows,prepareTrigger,prepareCarryover,prepareAction,priorDayCash,shouldAlertPreparation,pickupReview,evidenceFromSnapshot,type CashObservation,type CodSection,type Journey} from './lm-cod-workflow';
import {CodRuntime} from './lm-cod-runtime';
import {codCacheGet,codCachePut,loadCodJourneys} from './lm-cod-journeys';

type Source={id:string;station_code:string;report_code?:string};
export type CodConfig={cod_route_service_url?:string|null;cod_reconciliation_allowance_minutes?:number;cod_shortfalls_since?:string;cod_shortfall_lead_minutes?:number};
export type CodWorkflowResult={cleared:string[];bankIssue?:{ids:string[];amount:number};sections:CodSection[];slips:Array<{key:string;code:string;at:number;amount:number;returned:boolean}>;acks:string[];shortAcks:string[];asOf:string;bankRows:[string,string|number][]};
const istClock=(at:number)=>new Date(at+330*60000).toISOString().slice(11,16);
const fresh=(stamp:string,now:number)=>Number.isFinite(Date.parse(stamp))&&now-Date.parse(stamp)<=15*60000&&Date.parse(stamp)<=now+60000;
export async function loadCodWorkflow(company:string,source:Source,day:string,slot:string,config:CodConfig,runtime:CodRuntime):Promise<CodWorkflowResult>{
 return runtime.memo(`workflow:${company}:${source.id}:${slot}`,async()=>{
  const db=reportBotDb(),now=Date.now(),code=source.report_code||source.station_code;
  const [s,settings,exceptions]=await Promise.all([
   fetchCodStatus(code,false),
   db.from('cod_station_settings').select('pickup_configured,pickup_rule,pickup_window_start,pickup_window_end,next_day_preparation_from').eq('company_id',company).eq('location_id',source.id).eq('is_active',true).maybeSingle(),
   loadCodExceptions(db,company,[source.id],false,day),
  ]);
  if(settings.error)throw new Error(settings.error.message);
  if(s.stationCode!==code||s.date!==day)throw new Error('COD source station/date mismatch');
  const r=s.reconciliation,p=s.prepareDeposit,m=s.remittances;
  if(r.state!=='ok'||!r.data?.complete||p.state!=='ok'||!p.data||m.state!=='ok'||!m.data?.complete||![r.checkedAt,p.checkedAt,m.checkedAt].every(stamp=>fresh(stamp,now)))throw new Error('Fresh complete COD evidence unavailable; station not alerted');
  const result:CodWorkflowResult={cleared:[],sections:[],slips:[],acks:[],shortAcks:[],asOf:s.fetchedAt,bankRows:[]};
  const submitted=m.data.rows.filter(row=>{const at=submittedTime(row);return at!==null&&codDay(at)===day&&at<=now;});
  const observed=observedBankerWindow(m.data.rows,new Date(now));
  const policy=pickupPolicy(observed?{...settings.data,pickup_window_start:observed.start,pickup_window_end:observed.end}:settings.data);
  const nonPickup=observedNonPickupWeekday(m.data.rows,s.remittanceWindow,new Date(now));
  const scheduled=slot.endsWith(':00');
  const evening=scheduled&&slot>='19:00';
  const closing=evening&&slot>='22:00';
  const pendingDrivers=r.data.drivers.filter(d=>d.pendingAmount>0);
  if(!pendingDrivers.length)result.cleared.push('recon');
  if(p.data.actualAmount<=0)result.cleared.push('prepare');
  if(policy&&!dueBankRows(m.data.rows,policy,now).length||exceptions.some(e=>e.kind==='Banker Not Reported'))result.cleared.push('bank');
  // Route enrichment is only for cash-pending DAs, shared across stages and capped per run.
  let journeys=new Map<string,Journey>();
  if(pendingDrivers.length&&(evening||policy&&istClock(now)>=policy.start&&istClock(now)<=policy.end)){
   journeys=await loadCodJourneys(company,source.id,day,pendingDrivers.map(d=>d.id),runtime,config.cod_route_service_url||null,config.cod_reconciliation_allowance_minutes||15).catch(()=>new Map<string,Journey>());
  }
  const evidence=evidenceFromSnapshot(s,journeys);
  if(evidence){
   const write=await db.from('report_bot_cod_observations').upsert({company_id:company,location_id:source.id,observed_at:new Date(evidence.at).toISOString(),payload:evidence},{onConflict:'company_id,location_id,observed_at',ignoreDuplicates:true});
   if(write.error)throw new Error(write.error.message);
  }
  if(evening||scheduled){
   const rows=pendingDrivers.flatMap(d=>{
    const j=journeys.get(d.id);
    const oldest=Math.min(...d.packages.map(pkg=>Number(pkg.collectedAt)).filter(at=>Number.isFinite(at)&&at>0));
    const prior=Number.isFinite(oldest)&&codDay(oldest)<day;
    if(!evening){const earlier=priorDayCash(d.packages,day);return earlier.amount>0?[[d.name||d.id,earlier.dates,codMoney(Math.min(d.pendingAmount,earlier.amount))]]:[];}
    const overdue=!!j?.closed&&j.dueAt!==null&&now>=j.dueAt;
    if(!closing&&!prior&&(!evening||!overdue))return [];
    return [[d.name||d.id,j?.lastStopAt?codClock(j.lastStopAt):'Unavailable',j?.distanceKm!=null?`${j.distanceKm} km${approximateJourney(j)?' direct':''} · ~${j.travelMinutes} min`:'Unavailable',codClock(j?.returnAt??null),codClock(j?.dueAt??null),codMoney(d.pendingAmount),prior?`${Math.floor((Date.parse(day+'T00:00:00+05:30')-Date.parse(codDay(oldest)+'T00:00:00+05:30'))/86400000)}d pending`:overdue?(approximateJourney(j)?'Est. return check':'Overdue'):j?.closed?'Closing check':'On road / unverified']];
   });
   if(rows.length)result.sections.push({issue:{ids:rows.map(row=>String(row[0])),amount:rows.reduce((n,row)=>n+Number(String(row[evening?5:2]).replace(/[^0-9.]/g,'')),0)},key:'recon',title:evening?'DA reconciliation':'Previous-day DA reconciliation',columns:evening?['DA','Last stop','Distance · est. travel','Est. return','Recon. due','Cash','Status']:['DA','COD date','Pending cash'],rows,owner:'team',tone:'attention',action:!evening?'Previous-day COD reconciliation is still pending. Collect and reconcile the amounts shown now.':closing?'Reconcile all cash already returned. Confirm the return plan for DAs still on road; do not carry collections or RTS into tomorrow.':'Confirm return for estimated checks; collect and reconcile any cash already returned. Direct-distance estimates allow extra travel time and do not confirm arrival. Reply with the reason and clearance time for exceptions.'});
  }
  // Preparing current-day cash at closure is independent from the next-day bank handover.
  if(scheduled&&(evening||policy&&istClock(now)>=policy.start&&istClock(now)<=policy.end)){
   const board=await runtime.memo(`board:${source.id}`,()=>fetchLoadFlashBoard(day,[code])).catch(()=>null);
   const station=board?.stations.find(x=>x.stationCode===code&&x.businessDate===day&&x.hasSnapshot&&x.fetchedAt&&fresh(x.fetchedAt,now));
   const oor=station?station.board.daDsr.reduce((n,d)=>n+Number(d.oor||0),0):null;
   const closureKey='closure';let closure=await codCacheGet<{at:number}>(company,source.id,day,closureKey);
   if(oor!==0||r.data.pendingAmount>0){if(closure)await codCachePut(company,source.id,day,closureKey,null);closure=null;}
   else if(!closure){closure={at:now};await codCachePut(company,source.id,day,closureKey,closure);}
   const trigger=prepareTrigger({amount:p.data.actualAmount,oor,reconPending:r.data.pendingAmount,closedSince:closure?.at??null,policy,submittedToday:submitted.length>0,nonPickup,now});
   let carryover=false;
   if(trigger&&slot<'19:00'){
    const previous=await db.from('report_bot_cod_observations').select('payload').eq('company_id',company).eq('location_id',source.id).lt('observed_at',day+'T00:00:00+05:30').gte('observed_at',new Date(Date.parse(day+'T00:00:00+05:30')-86400000).toISOString()).order('observed_at',{ascending:false}).limit(1).maybeSingle();
    if(previous.error)throw new Error(previous.error.message);
    carryover=prepareCarryover(previous.data?.payload as CashObservation|undefined,p.data.actualAmount,m.data.rows,day);
   }
   if(shouldAlertPreparation(trigger,slot,carryover))result.sections.push({issue:{ids:['prepare'],amount:p.data.actualAmount},key:'prepare',title:carryover?'Prepare Deposit · carried from yesterday':'Prepare Deposit pending',columns:['Reconciled cash','Pickup cycle'],rows:[[codMoney(p.data.actualAmount),policy?.rule||'Not configured']],owner:'team',tone:'attention',action:prepareAction(p.data.actualAmount,trigger==='pickup',carryover)});
  }
  // Review each actual submission once. A snapshot AFTER pickup cannot prove what was available BEFORE.
  const reviewed=new Set<string>();
  if(evidence)for(const remittance of submitted){
   if(reviewed.has(remittance.code||remittance.id))continue;
   const at=submittedTime(remittance)!;const ack='pickup-sent:'+remittance.id;
   if(await codCacheGet(company,source.id,day,ack))continue;
   const reviewKey='pickup-review:'+remittance.id;
   let review=await codCacheGet<NonNullable<ReturnType<typeof pickupReview>>>(company,source.id,day,reviewKey);
   if(!review){
    const before=await db.from('report_bot_cod_observations').select('payload').eq('company_id',company).eq('location_id',source.id).lt('observed_at',new Date(at).toISOString()).gte('observed_at',new Date(at-45*60000).toISOString()).order('observed_at',{ascending:false}).limit(1).maybeSingle();
    if(before.error)throw new Error(before.error.message);
    review=pickupReview(before.data?.payload as CashObservation|undefined,evidence,at);
    if(review)await codCachePut(company,source.id,day,reviewKey,review);
   }
   if(!review||review.gap<=1&&!review.lateDas.length)continue;
   const rows:Array<Array<string|number>>=[['Cash already reconciled / prepared',codMoney(review.available)],['Submitted to CMS',codMoney(review.deposited)],['Difference to explain',codMoney(review.gap)]];
   if(review.gap>1)result.sections.push({key:'pickup',title:`After CMS submission · ${codClock(at)} · ${review.codes.join(', ')}`,columns:['Cash at pickup','Amount'],rows,owner:'team',tone:'attention',action:`${codMoney(review.available)} was recorded as available before pickup, but only ${codMoney(review.deposited)} was submitted. ${review.gap>1?`Explain the ${codMoney(review.gap)} difference and confirm the next handover time.`:''}`});
   if(review.lateDas.length)result.sections.push({key:'pickup',title:'DA cash already due before pickup · separate from available cash',columns:['DA','Last stop','Reconciliation due','Unreconciled cash'],rows:review.lateDas.map(d=>[d.name,codClock(d.lastStopAt),codClock(d.dueAt),codMoney(d.amount)]),owner:'team',tone:'attention',action:`${review.lateDas.map(d=>`${d.name}: ${codMoney(d.amount)}`).join('; ')} was already due for reconciliation before pickup. Why was it not reconciled and included? Confirm collection and handover time.`});
   for(const item of submitted.filter(row=>review!.codes.includes(row.code||row.id))){reviewed.add(item.code||item.id);result.acks.push('pickup-sent:'+item.id);}
  }
  if(scheduled&&policy&&observed&&!nonPickup&&!exceptions.some(e=>e.kind==='Banker Not Reported')&&now>=Date.parse(`${day}T${observed.end}:00+05:30`)+30*60000){
   const due=dueBankRows(m.data.rows,policy,now);
   result.bankIssue={ids:due.map(x=>x.row.id),amount:due.reduce((n,x)=>n+x.row.actualAmount,0)};
   if(due.length)result.bankRows=[['CMS usually reports',`${observed.start}–${observed.end} IST`],['Due remittances',`${due.length} · ${codMoney(due.reduce((n,v)=>n+v.row.actualAmount,0))}`],...(submitted.length?[['Submitted today',codClock(Math.max(...submitted.map(row=>submittedTime(row)!)))]]:[]) as [string,string|number][]];
  }
  // Match proof to every submitted remittance, not "some slip exists at station".
  let missingProofs=0,proofsChecked=!submitted.length;
  if(submitted.length){
   const pending=(await loadCodPendingReport(db,company,[source.id],false,day))[0];
   if(pending)proofsChecked=true;
   if(pending)for(const remittance of submitted){
    const at=submittedTime(remittance)!,elapsed=(now-at)/60000;if(elapsed<30)continue;
    const reference=remittance.code?.trim().toUpperCase();if(!reference)continue;
    const proofs=pending.entries.filter(e=>String(e.remittance_code||e.reference_no||'').trim().toUpperCase()===reference);
    if(proofs.some(e=>hasSlipProof(e)&&!e.returned_at))continue;
    missingProofs++;
    const stage=Math.floor((elapsed-30)/120),key=`slip:${remittance.id}:${stage}`;
    if(await codCacheGet(company,source.id,day,'sent:'+key))continue;
    result.slips.push({key,code:reference,at,amount:remittance.actualAmount,returned:proofs.some(e=>!!e.returned_at)});
   }
  }
  if(proofsChecked&&!missingProofs)result.cleared.push('slip');
  const shorts=await trackCodShortfalls(company,source.id,m.data.rows,m.checkedAt,config.cod_shortfalls_since||day,day,slot,observed?.start||policy?.start||null,nonPickup,config.cod_shortfall_lead_minutes??60);
  if(shorts.section){result.sections.push(shorts.section);result.shortAcks=shorts.acks;}
  return result;
 });
}

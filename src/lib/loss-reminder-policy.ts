import {casePhase, requestSent} from './ops-pulse/nl-dispute-policy';
import {isRecoverable} from './ops-pulse/nl-loss-policy';
import {hasFinalLossOutcome} from './ops-pulse/loss-recovery-controls';
import {recoveryDetailsUpdated} from './ops-pulse/loss-final-summary';

export const LOSS_REMINDER_STAGES = ['recovery','dispute','response'] as const;
export type LossReminderStage = typeof LOSS_REMINDER_STAGES[number];
export const LOSS_REMINDER_EVENTS = LOSS_REMINDER_STAGES.flatMap(stage=>['morning','afternoon'].map(slot=>`loss_reminder_${stage}_${slot}`));
export const LOSS_REMINDER_COPY = {
 recovery:{title:'NL / SLP Final · Recovery update pending',action:'Update recovery',note:'Assign the responsible person, full recovery share and payroll month.',color:'#c45119'},
 dispute:{title:'NL · Dispute pending',action:'Review disputes',note:'Dispute or accept each pending shipment and submit the required evidence.',color:'#b45309'},
 response:{title:'NL · Station response pending',action:'Respond to Amazon',note:'Amazon has asked for details. Complete the station response and evidence.',color:'#b42338'},
} as const;
export function lossReminderStage(event:string):LossReminderStage|null {
 const match=/^loss_reminder_(recovery|dispute|response)_(morning|afternoon)$/.exec(event);
 return match ? match[1] as LossReminderStage : null;
}
export function lossReminderInWindow(stage:LossReminderStage,date:string){
 const day=Number(date.slice(8,10));
 return stage==='recovery' ? day>=20||day<=5 : stage==='dispute' ? day>=7&&day<=11 : day>=11&&day<=20;
}
/** Recovery keeps one thread from the 20th through the following 5th. */
export function lossReminderThreadMonth(event:string,date:string){
 if(lossReminderStage(event)==='recovery' && Number(date.slice(8,10))<=5){
  const d=new Date(date.slice(0,7)+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7);
 }
 return date.slice(0,7);
}
/** Report-date calendar months, independent of the monthly email thread or payroll month. */
export function lossReminderMonths(date:string){
 const current=date.slice(0,7),previous=new Date(current+'-01T12:00:00Z');
 previous.setUTCMonth(previous.getUTCMonth()-1);
 return [previous.toISOString().slice(0,7),current];
}
/** NL recovery follows the previous loss month of the 20th–5th recovery cycle. */
export function lossReminderIncludesMonth(stage:LossReminderStage,date:string,report:string,month:string){
 if(stage==='recovery'&&report==='nl'){
  const cycle=lossReminderThreadMonth('loss_reminder_recovery_morning',date);
  return month===lossReminderMonths(cycle+'-20')[0];
 }
 return lossReminderMonths(date).includes(month);
}
export function lossReminderPeriodLabel(stage:LossReminderStage,date:string){
 const label=(month:string)=>new Date(month+'-01T12:00:00Z').toLocaleDateString('en-IN',{month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
 const months=lossReminderMonths(date);
 if(stage==='recovery'){
  const cycle=lossReminderThreadMonth('loss_reminder_recovery_morning',date);
  return 'NL: '+label(lossReminderMonths(cycle+'-20')[0])+' · SLP: '+months.map(label).join(' – ');
 }
 return 'Loss months: '+months.map(label).join(' – ');
}
export const lossReminderThreadEvent=(event:string)=>lossReminderStage(event)?`loss_reminder_${lossReminderStage(event)}_morning`:event;
export function lossReminderScheduleTime(event:string,date:string,config:Record<string,unknown>){
 const once=config.one_time_schedule as {date?:string;time?:string}|undefined;
 return String(lossReminderStage(event)&&once?.date===date?once.time:config.schedule_time||'');
}
export function lossReminderEdition(event:string,time?:string){
 if(time&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){
  const [hour,minute]=time.split(':').map(Number);
  return `${hour%12||12}:${String(minute).padStart(2,'0')} ${hour>=12?'p.m.':'a.m.'}`;
 }
 return event.endsWith('_afternoon')?'4:00 p.m.':'11:00 a.m.';
}
export type ReminderStation={id:string;station_code:string;source_code:string;station_name:string;cluster:string};
export type ReminderCase={month:string;case_key:string;station_code:string;report:string;amount:number|null;source_present:boolean;source_status:string|null;data_source:string;final_seen_at:string|null;lifecycle_status:string;last_seen_at:string;source_updated_at:string|null;details:{tid?:string;period?:string;in_final?:boolean;case_status?:string;extra?:Record<string,string>}};
export type ReminderPlan={month:string;case_key:string;is_deleted?:boolean;approval_status:string;source_amount:number;source_status:string|null;outcome_code:string;recovery_details?:Record<string,unknown>;allocations:unknown[]};
export type ReminderRequest={month:string;case_key:string;status:'draft'|'submitted'|'filed'|'returned';source_stage:string|null};
export type ReminderRedispute={month:string;case_key:string;enabled:boolean;workflow_status:string};
export type ReminderRow={stationId:string;station:string;stationName:string;owner:string;shipmentId:string;caseKey:string;month:string;report:string;amount:number;pending:boolean;status:string;updatedAt:string|null;link:string};
const key=(r:{month:string;case_key:string})=>JSON.stringify([r.month,r.case_key]);
export function selectLossReminderRows(stage:LossReminderStage,input:{date:string;stations:ReminderStation[];cases:ReminderCase[];plans:ReminderPlan[];requests:ReminderRequest[];redisputes:ReminderRedispute[];recoverableStatuses:string[]}) {
 const stations=new Map(input.stations.map(s=>[s.source_code,s])),plans=new Map(input.plans.map(p=>[key(p),p])),requests=new Map(input.requests.map(p=>[key(p),p])),redisputes=new Map(input.redisputes.map(p=>[key(p),p]));
 const result:ReminderRow[]=[];
 for(const c of input.cases){
  if(!lossReminderIncludesMonth(stage,input.date,c.report,c.month))continue;
  const s=stations.get(c.station_code);if(!s||!c.source_present||c.amount===null||!Number.isFinite(Number(c.amount))||Number(c.amount)<=0)continue;
  const phase=casePhase({case_status:c.details?.case_status,nl_status:c.source_status,extra:c.details?.extra});
  let pending=true,status='Pending update';
  if(stage==='recovery'){
   if(!['nl','slp'].includes(c.report))continue;
   if(c.report==='slp' ? !(c.final_seen_at||c.details?.in_final) : !isRecoverable(c.source_status,input.recoverableStatuses)||!hasFinalLossOutcome(true,c.source_status,c.details?.case_status,c.details?.extra?.current_sla_stage))continue;
   if(['not_recoverable','rejected','written_off','recovered'].includes(c.lifecycle_status))continue;
   const redispute=redisputes.get(key(c));if(redispute?.enabled||redispute?.workflow_status==='won')continue;
   const p=plans.get(key(c));
   pending=!recoveryDetailsUpdated(c,p,c.report==='slp');
   if(['needs_review','returned_to_station'].includes(c.lifecycle_status))pending=true;
   status=pending?(p?.approval_status==='returned'?'Returned · update needed':'Recovery update pending'):p?.approval_status==='proposed'?'Updated · approval pending':'Recovery updated';
  }else{
   if(c.report!=='nl'||c.data_source!=='live'||phase.key!==(stage==='dispute'?'action':'respond'))continue;
   // A first-round dispute never satisfies a later Amazon response request.
   if(requestSent(requests.get(key(c)),c.details?.extra?.current_sla_stage))continue;
   status=stage==='dispute'?'Dispute / accept pending':'Amazon replied · station response pending';
  }
  const params=new URLSearchParams({station:c.station_code});
  let path='/team-ops/losses/nl';
  if(c.report==='slp'){path='/team-ops/losses/slp-final';params.set('period',c.details?.period||'all');}
  else{params.set('view',stage==='recovery'?'historic':'live');params.set('month',c.month);}
  result.push({stationId:s.id,station:s.station_code,stationName:s.station_name,owner:s.cluster,shipmentId:c.details?.tid||c.case_key.replace(/^slp:/,''),caseKey:c.case_key,month:c.month,report:c.report==='slp'?'SLP Final':'NL',amount:Number(c.amount),pending,status,updatedAt:c.source_updated_at||c.last_seen_at,link:path+'?'+params});
 }
 return result.sort((a,b)=>b.amount-a.amount||a.station.localeCompare(b.station)||a.shipmentId.localeCompare(b.shipmentId));
}

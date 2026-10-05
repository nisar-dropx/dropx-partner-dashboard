import type { FleetAuditProgrammeConfig } from './audit-programme-config';
export type PlanVehicle={id:string;vehicle_no:string;station_code:string;status:string|null};
export type PlanStation={station_code:string;latitude:number|string|null;longitude:number|string|null};
export type PlanAudit={id:string;vehicle_id:string;scheduled_for:string;scheduled_reason:string|null;status:string;assigned_to:string|null;updated_at:string};
export type AuditMode='physical'|'video';
export type PlannedAudit={id:string|null;vehicle_id:string;mode:AuditMode;scheduled_for:string;scheduled_reason:string;assigned_to:string|null};
export const auditMode=(reason:unknown):AuditMode=>/^\[mode:video\]/i.test(String(reason||'').trim())?'video':'physical';
const key=(vehicle:string,mode:AuditMode)=>`${vehicle}:${mode}`;
const gap=(a:string,b:string)=>Math.abs(Date.parse(a)-Date.parse(b))/86400000;
const weekday=(date:string)=>new Date(`${date}T12:00:00Z`).getUTCDay();
function distance(a?:PlanStation,b?:PlanStation){
 const raw=[a?.latitude,a?.longitude,b?.latitude,b?.longitude];
 if(raw.some(n=>n==null||n===''||!Number.isFinite(Number(n))))return null;
 const [x,y,u,v]=raw.map(n=>Number(n)*Math.PI/180),h=Math.sin((u-x)/2)**2+Math.cos(x)*Math.cos(u)*Math.sin((v-y)/2)**2;
 return 12742*Math.asin(Math.sqrt(Math.min(1,h)));
}
/** Pure monthly planner. Never moves started/completed audits or silently exceeds capacity. */
export function planAuditMonth({month,today,config,vehicles,audits,stations,leaveDates=[],inspectorId=null,rebalance=false}:{month:string;today:string;config:FleetAuditProgrammeConfig;vehicles:PlanVehicle[];audits:PlanAudit[];stations:PlanStation[];leaveDates?:string[];inspectorId?:string|null;rebalance?:boolean}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<today.slice(0,7))throw new Error('Choose the current month or a future month.');
 const [year,m]=month.split('-').map(Number),end=new Date(Date.UTC(year,m,0)).getUTCDate();
 const blocked=new Set(leaveDates);const forbidden=(date:string)=>config.excludedWeekdays.includes(weekday(date))||blocked.has(date);
 const dates=Array.from({length:end},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`).filter(d=>d>=today&&!forbidden(d));
 const active=audits.filter(a=>a.status!=='cancelled'&&a.scheduled_for.startsWith(month));
 const slots=new Set<string>();for(const a of active){const k=key(a.vehicle_id,auditMode(a.scheduled_reason));if(slots.has(k))throw new Error('Duplicate monthly audit slots must be reconciled before rebuilding.');slots.add(k);}
 const fleet=vehicles.filter(v=>!['sold','returned','disposed'].includes((v.status||'').toLowerCase()));
 const vehicleMap=new Map(vehicles.map(v=>[v.id,v])),stationMap=new Map(stations.map(s=>[s.station_code.toUpperCase(),s]));
 const stationOf=(id:string)=>vehicleMap.get(id)?.station_code.toUpperCase()||'UNASSIGNED';
 const fixed=active.filter(a=>a.status!=='scheduled'||(!rebalance&&!forbidden(a.scheduled_for))||((!String(a.scheduled_reason).includes('Auto programme')||/\[(moved|swapped):/.test(a.scheduled_reason||''))&&!forbidden(a.scheduled_for)));
 const movable=active.filter(a=>!fixed.includes(a));
 const physicalLoad=new Map<string,number>(),virtualLoad=new Map<string,number>(),visits=new Map<string,Set<string>>(),pairDates=new Map<string,string>();
 function reserve(vehicle:string,mode:AuditMode,date:string){const loads=mode==='physical'?physicalLoad:virtualLoad;loads.set(date,(loads.get(date)||0)+1);pairDates.set(key(vehicle,mode),date);if(mode==='physical'){const codes=visits.get(date)||new Set();codes.add(stationOf(vehicle));visits.set(date,codes);}}
 fixed.forEach(a=>reserve(a.vehicle_id,auditMode(a.scheduled_reason),a.scheduled_for));
 const tasks:{vehicle_id:string;mode:AuditMode;existing?:PlanAudit}[]=movable.map(a=>({vehicle_id:a.vehicle_id,mode:auditMode(a.scheduled_reason),existing:a}));
 for(const v of fleet)for(const mode of ['physical','video'] as const)if(!slots.has(key(v.id,mode)))tasks.push({vehicle_id:v.id,mode});
 const changes:PlannedAudit[]=[],unplaced:{vehicleNo:string;mode:AuditMode;reason:string}[]=[];
 const minGap=config.minGapDays;
 const fitsPair=(vehicle:string,mode:AuditMode,date:string)=>{const other=pairDates.get(key(vehicle,mode==='physical'?'video':'physical'));return !other||gap(date,other)>=minGap;};
 function assign(task:typeof tasks[number],date:string){reserve(task.vehicle_id,task.mode,date);const reason=task.existing?.scheduled_reason||`[mode:${task.mode}] Auto programme · ${task.mode==='physical'?`station visit ${stationOf(task.vehicle_id)}`:'monthly virtual review'}`;if(!task.existing||task.existing.scheduled_for!==date)changes.push({id:task.existing?.id||null,vehicle_id:task.vehicle_id,mode:task.mode,scheduled_for:date,scheduled_reason:reason,assigned_to:task.existing?.assigned_to||inspectorId});}
 const groups=new Map<string,typeof tasks>();for(const task of tasks.filter(t=>t.mode==='physical')){const code=stationOf(task.vehicle_id);groups.set(code,[...(groups.get(code)||[]),task]);}
 // Nearest next station makes adjacent visit days geographically coherent when coordinates exist.
 const remaining=[...groups.keys()].sort(),route:string[]=[];while(remaining.length){const previous=route.at(-1);if(previous)remaining.sort((a,b)=>(distance(stationMap.get(previous),stationMap.get(a))??Infinity)-(distance(stationMap.get(previous),stationMap.get(b))??Infinity)||a.localeCompare(b));route.push(remaining.shift()!);}
 const batches=route.flatMap(code=>{const list=groups.get(code)!.sort((a,b)=>(vehicleMap.get(a.vehicle_id)?.vehicle_no||'').localeCompare(vehicleMap.get(b.vehicle_id)?.vehicle_no||''));return Array.from({length:Math.ceil(list.length/config.maxPhysicalPerDay)},(_,i)=>list.slice(i*config.maxPhysicalPerDay,(i+1)*config.maxPhysicalPerDay));});
 batches.forEach((batch,index)=>{
  const target=batches.length===1?Math.floor((dates.length-1)/2):Math.round(index*(dates.length-1)/(batches.length-1));
  const candidates=dates.filter(d=>(physicalLoad.get(d)||0)+batch.length<=config.maxPhysicalPerDay&&((visits.get(d)?.has(stationOf(batch[0].vehicle_id)))||(visits.get(d)?.size||0)<config.maxPhysicalStationsPerDay)&&batch.every(t=>fitsPair(t.vehicle_id,'physical',d)));
  candidates.sort((a,b)=>Math.abs(dates.indexOf(a)-target)-Math.abs(dates.indexOf(b)-target)||(physicalLoad.get(a)||0)-(physicalLoad.get(b)||0)||a.localeCompare(b));
  if(candidates[0])batch.forEach(t=>assign(t,candidates[0]));else batch.forEach(t=>unplaced.push({vehicleNo:vehicleMap.get(t.vehicle_id)?.vehicle_no||t.vehicle_id,mode:t.mode,reason:'No station visit slot satisfies capacity, leave and spacing rules.'}));
 });
 // Virtual reviews use all working days, balancing the combined daily workload.
 for(const task of tasks.filter(t=>t.mode==='video').sort((a,b)=>(pairDates.get(key(a.vehicle_id,'physical'))||'').localeCompare(pairDates.get(key(b.vehicle_id,'physical'))||'')||a.vehicle_id.localeCompare(b.vehicle_id))){
  const physicalDate=pairDates.get(key(task.vehicle_id,'physical'));
  const candidates=dates.filter(d=>(virtualLoad.get(d)||0)<config.maxVirtualPerDay&&fitsPair(task.vehicle_id,'video',d));
  candidates.sort((a,b)=>((physicalLoad.get(a)||0)+(virtualLoad.get(a)||0))-((physicalLoad.get(b)||0)+(virtualLoad.get(b)||0))||(virtualLoad.get(a)||0)-(virtualLoad.get(b)||0)||(physicalDate?Math.abs(gap(a,physicalDate)-14)-Math.abs(gap(b,physicalDate)-14):0)||a.localeCompare(b));
  if(candidates[0])assign(task,candidates[0]);else unplaced.push({vehicleNo:vehicleMap.get(task.vehicle_id)?.vehicle_no||task.vehicle_id,mode:task.mode,reason:'No virtual slot satisfies capacity, leave and spacing rules.'});
 }
 // A rebuild is atomic: never leave half a programme changed when capacity is insufficient.
 if(unplaced.length)throw new Error(`${unplaced.length} audit slots cannot fit the remaining working days. Increase daily capacity or revise spacing in audit programme settings. No dates were changed.`);
 return {changes,vehicles:fleet.length,days:dates.map(date=>({date,physical:physicalLoad.get(date)||0,virtual:virtualLoad.get(date)||0,stations:[...(visits.get(date)||[])]})),fixed:fixed.length};
}

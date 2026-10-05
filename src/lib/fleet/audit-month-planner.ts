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
 if(raw.some(n=>n==null||String(n).trim()===''||!Number.isFinite(Number(n))))return null;
 if(Math.abs(Number(raw[0]))>90||Math.abs(Number(raw[2]))>90||Math.abs(Number(raw[1]))>180||Math.abs(Number(raw[3]))>180)return null;
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
 const leaveAffected=new Set(active.filter(a=>a.status==='scheduled'&&forbidden(a.scheduled_for)).map(a=>a.vehicle_id));
 const fixed=active.filter(a=>a.status!=='scheduled'||(!rebalance&&!forbidden(a.scheduled_for)&&!leaveAffected.has(a.vehicle_id))||((!/Auto programme|\[auto-moved:/.test(String(a.scheduled_reason))||/\[(moved|swapped):/.test(a.scheduled_reason||''))&&!forbidden(a.scheduled_for)));
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
 // Keep a station's pending physical work together. Never split a station to fill capacity.
 type Visit={codes:string[];tasks:typeof tasks;anchor:string|null};
 const compatible=(codes:string[])=>codes.length<=config.maxPhysicalStationsPerDay&&codes.every((a,i)=>codes.slice(i+1).every(b=>{const km=distance(stationMap.get(a),stationMap.get(b));return km!==null&&km<=config.nearbyStationKm;}));
 const anchorFor=(code:string)=>{const existing=[...visits].filter(([date,codes])=>dates.includes(date)&&codes.has(code)).map(([date])=>date);return existing.length===1?existing[0]:null;};
 const pending=[...groups.keys()].sort().map(code=>({codes:[code],tasks:groups.get(code)!,anchor:anchorFor(code)}));
 function fitsVisit(visit:Visit,date:string){
  const codes=[...new Set([...(visits.get(date)||[]),...visit.codes])];
  return (!visit.anchor||visit.anchor===date)&&(physicalLoad.get(date)||0)+visit.tasks.length<=config.maxPhysicalPerDay&&compatible(codes)&&visit.tasks.every(t=>fitsPair(t.vehicle_id,'physical',date));
 }
 // Greedy complete-link grouping prevents chains of individually nearby but collectively distant stations.
 const batches:Visit[]=[];
 while(pending.length){
  const visit=pending.shift()!;
  pending.sort((a,b)=>Math.min(...a.codes.flatMap(c=>visit.codes.map(v=>distance(stationMap.get(c),stationMap.get(v))??Infinity)))-Math.min(...b.codes.flatMap(c=>visit.codes.map(v=>distance(stationMap.get(c),stationMap.get(v))??Infinity)))||a.codes[0].localeCompare(b.codes[0]));
  for(let i=0;i<pending.length;){const next=pending[i];const joined:Visit={codes:[...visit.codes,...next.codes],tasks:[...visit.tasks,...next.tasks],anchor:visit.anchor||next.anchor};
   if((!visit.anchor||!next.anchor||visit.anchor===next.anchor)&&compatible(joined.codes)&&dates.some(d=>fitsVisit(joined,d))){Object.assign(visit,joined);pending.splice(i,1);}else i++;
  }
  batches.push(visit);
 }
 // Place anchored visits first; spread remaining visits across all available working days.
 batches.sort((a,b)=>Number(Boolean(b.anchor))-Number(Boolean(a.anchor))||a.codes[0].localeCompare(b.codes[0]));
 const freeCount=batches.filter(b=>!b.anchor).length;let freeIndex=0;
 for(const batch of batches){
  const target=batch.anchor?dates.indexOf(batch.anchor):freeCount===1?Math.floor((dates.length-1)/2):Math.round(freeIndex++*(dates.length-1)/(freeCount-1));
  const candidates=dates.filter(d=>fitsVisit(batch,d));
  candidates.sort((a,b)=>Math.abs(dates.indexOf(a)-target)-Math.abs(dates.indexOf(b)-target)||(physicalLoad.get(a)||0)-(physicalLoad.get(b)||0)||a.localeCompare(b));
  if(candidates[0])batch.tasks.forEach(t=>assign(t,candidates[0]));else batch.tasks.forEach(t=>unplaced.push({vehicleNo:vehicleMap.get(t.vehicle_id)?.vehicle_no||t.vehicle_id,mode:t.mode,reason:`Whole-station visit ${batch.codes.join(', ')} does not fit capacity, leave or spacing rules.`}));
 }
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

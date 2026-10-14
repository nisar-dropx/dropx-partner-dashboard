import type {Entry} from './model';
type Row=Record<string,any>;
export type ManagerPayroll={id:string;personId:string;profileType:string;from:string;to:string;paise:number;source:string};
const active=(r:Row,date:string)=>r.effective_from<=date&&(!r.effective_to||r.effective_to>=date);
const isManager=(p:Row)=>/manager/i.test(`${p.label} ${p.designation_name}`)||['CLM','AOM','RM','CM'].includes(p.designation_code);
function split(total:number,weights:[string,number][]){const denominator=weights.reduce((n,[,w])=>n+w,0);let cumulative=0,previous=0;return weights.map(([code,w])=>{cumulative+=denominator?w/denominator:1/weights.length;const end=Math.round(total*cumulative),value=end-previous;previous=end;return [code,value] as const;});}
function daily(total:number,from:string,to:string,date:string){const count=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1,index=Math.round((Date.parse(date)-Date.parse(from))/86400000)+1;return Math.round(total*index/count)-Math.round(total*(index-1)/count);}
/** Allocate once across the full responsibility set before any dashboard filter. */
export function managerShares(input:{month:string;stations:Row[];people:Row;policies:Row[];rules:Row[];payroll:ManagerPayroll[]}){
 const {month,stations,people,policies,rules,payroll}=input,start=`${month}-01`,end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 const dates=Array.from({length:Number(end.slice(8))},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
 const byId=new Map(stations.map(s=>[s.id,s])),byCode=new Map(stations.map(s=>[s.station_code,s]));
 const operating=(code:string)=>{const s=byCode.get(code);return s&&!s.is_ho&&!s.hide_from_location_list&&!/^HO(?:_|$)/i.test(code);};
 const entries=new Map<string,Entry>(),consumedPayroll=new Map<string,number>(),issues=new Set<string>(),managerPeople=new Set<string>(),accruedPeople=new Set<string>();
 const managersByStation=new Map<string,Set<string>>();
 const allocations=new Map<string,{days:Set<string>;basis:Set<string>;targets:Set<string>;totalPaise:number}>();
 for(const person of people.employees??[]){
  const identity=`${person.profile_type??'employee'}:${person.id}`;
  const employed=(date:string)=>!((person.date_of_join&&person.date_of_join>date)||(person.last_working_date&&person.last_working_date<date)||(person.deleted_at&&person.deleted_at.slice(0,10)<=date)||(person.is_active===false&&!(person.last_working_date&&person.last_working_date>=date)));
  for(const date of dates){
   if((person.date_of_join&&person.date_of_join>date)||(person.last_working_date&&person.last_working_date<date)||(person.deleted_at&&person.deleted_at.slice(0,10)<=date)||(person.is_active===false&&!(person.last_working_date&&person.last_working_date>=date)))continue;
   const policy=policies.filter(p=>p.designation_code===person.designation&&p.effective_from<=date).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
   if(!policy||policy.mode==='excluded'||!isManager(policy))continue;
   const rule=rules.filter(r=>r.employee_id===person.id&&active(r,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
   const history=(people.assignments??[]).filter((a:Row)=>a.employee_id===person.id);
   let codes:string[]=rule?.station_codes??history.filter((a:Row)=>active(a,date)&&(policy.mode==='managed'||a.kind==='home')&&operating(a.station_code)).map((a:Row)=>a.station_code);
   const home=byId.get(person.location_id);
   if(!codes.length&&!history.length&&!person.has_home_assignments&&home&&!home.hide_from_location_list)codes=[home.station_code];
   if(!codes.length&&home?.is_ho)codes=[home.station_code];
   codes=[...new Set(codes)].sort();
   if(!codes.length){issues.add(`Manager ${person.employee_code||person.full_name}: no effective cost allocation; assign a home or responsible station.`);continue;}
   if(codes.some(code=>!byCode.has(code)))throw Error('A manager allocation references an unknown station.');
   if(policy.designation_code==='CLM')for(const code of codes){const names=managersByStation.get(code)??new Set<string>();names.add(person.full_name);managersByStation.set(code,names);}
   const actual=payroll.filter(p=>p.personId===person.id&&p.profileType===(person.profile_type??'employee')&&p.from<=date&&p.to>=date);
   if(actual.length>1)throw Error(`Overlapping final manager payroll for ${person.employee_code||person.full_name}.`);
   const salary=(people.salaries??[]).filter((s:Row)=>s.employee_id===person.id&&active(s,date)).sort((a:Row,b:Row)=>b.effective_from.localeCompare(a.effective_from)||String(b.id).localeCompare(String(a.id)))[0];
   let cost:number,source:string,basis:string;
   if(actual.length){const p=actual[0];if(p.from<start||p.to>end)throw Error('Manager payroll spans accounting months; allocate its payroll period first.');const covered=dates.filter(d=>d>=p.from&&d<=p.to&&employed(d)),index=covered.indexOf(date)+1;cost=Math.round(p.paise*index/covered.length)-Math.round(p.paise*(index-1)/covered.length);source=p.source;basis=`Final payroll ${p.id} · ${p.from} to ${p.to}`;consumedPayroll.set(p.id,(consumedPayroll.get(p.id)??0)+cost);}
   else{if(salary?.monthly_ctc==null||!Number.isFinite(Number(salary.monthly_ctc))||Number(salary.monthly_ctc)<0){issues.add(`Manager ${person.employee_code||person.full_name}: monthly salary is missing for ${month}.`);continue;}cost=daily(Math.round(Number(salary.monthly_ctc)*100),start,end,date);source='Manager salary accrual';basis=`Monthly salary ₹${Number(salary.monthly_ctc).toFixed(2)} · effective ${salary.effective_from}`;accruedPeople.add(identity);}
   managerPeople.add(identity);const method=rule?.allocation??policy.allocation??'equal';
   const weights=codes.map(code=>[code,method==='delivery_share'?Math.max(0,(people.volumes??[]).filter((v:Row)=>v.station_code===code&&v.work_date===date).reduce((n:number,v:Row)=>n+Number(v.deliveries||0),0)):1] as [string,number]);
   for(const [station,amount] of split(cost,weights)){
    const id=`manager:${identity}:${station}`,existing=entries.get(id);
    if(existing){existing.paise+=amount;if(existing.source!==source)existing.source='Manager payroll and salary accrual';}else entries.set(id,{id,month,station,sourceStation:station,side:'expense',head:'Manager share',description:`${person.full_name} · ${person.employee_code||''} · ${policy.designation_name||person.designation}`,paise:amount,source,reference:identity,date:end});
    const evidence=allocations.get(id)??{days:new Set(),basis:new Set(),targets:new Set(),totalPaise:0};evidence.days.add(date);evidence.basis.add(`${basis}; ${method==='delivery_share'?'delivery-weighted (equal on zero volume)':'equal'} share`);codes.forEach(c=>evidence.targets.add(c));evidence.totalPaise+=cost;allocations.set(id,evidence);
   }
  }
 }
 for(const [id,entry] of entries){const proof=allocations.get(id)!;entry.description+=` · ${proof.days.size} calendar days · ${[...proof.basis].join(' / ')} · responsibility set: ${[...proof.targets].sort().join(', ')}`;}
 if(accruedPeople.size)issues.add(`${accruedPeople.size} managers use effective salary accruals pending final payroll. Final payroll replaces the accrual for its covered days; manager cost is allocated once across all assigned stations, before filters.`);
 return {entries:[...entries.values()],consumedPayroll,issues:[...issues],managersByStation,managerCount:managerPeople.size,accruedManagerCount:accruedPeople.size};
}

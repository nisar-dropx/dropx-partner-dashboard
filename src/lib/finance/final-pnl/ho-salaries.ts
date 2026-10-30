import type {Entry} from './model';
import type {ManagerPayroll} from './manager-shares';
type Row=Record<string,any>;
const on=(r:Row,d:string)=>r.effective_from<=d&&(!r.effective_to||r.effective_to>=d);
/** Only the remaining HO salary enters the pool; station-assigned People cost is already charged. */
export function hoSalaries(month:string,facts:Row,stations:Row[],allocated:Entry[],payroll:ManagerPayroll[]){
 const days=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate(),dates=Array.from({length:days},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`),entries=new Map<string,Entry>(),issues=new Set<string>(),consumedPayroll=new Map<string,number>();
 const shared=new Map<string,number>();for(const e of allocated)for(const d of e.details??[]){const key=`${e.reference}:${d.date}`;shared.set(key,(shared.get(key)??0)+d.paise);}
 for(const p of facts.people??[]){
  const identity=`${p.profile_type}:${p.id}`,employed=(d:string)=>!(p.date_of_join&&p.date_of_join>d||p.last_working_date&&p.last_working_date<d||p.deleted_at&&p.deleted_at.slice(0,10)<=d||p.is_active===false&&!(p.last_working_date&&p.last_working_date>=d));
  for(const [index,date] of dates.entries()){
   if(!employed(date))continue;
   const assignment=(facts.assignments??[]).filter((a:Row)=>a.person_id===p.id&&on(a,date)).sort((a:Row,b:Row)=>b.effective_from.localeCompare(a.effective_from))[0],station=assignment?.station_code??p.station_code;
   if(!stations.some(s=>s.station_code===station&&s.is_ho))continue;
   const actual=payroll.filter(r=>r.personId===p.id&&r.profileType===p.profile_type&&r.from<=date&&r.to>=date);
   if(actual.length>1)throw Error(`Overlapping final HO payroll for ${p.code}.`);
   const salary=(facts.salaries??[]).filter((s:Row)=>s.person_id===p.id&&on(s,date)).sort((a:Row,b:Row)=>b.effective_from.localeCompare(a.effective_from))[0];
   let gross:number,reference:string,source:string;
   if(actual.length){const r=actual[0];if(r.from<dates[0]||r.to>dates[dates.length-1])throw Error('HO payroll spans months; allocate its payroll period first.');const covered=dates.filter(d=>d>=r.from&&d<=r.to&&employed(d)),i=covered.indexOf(date);gross=Math.round(r.paise*(i+1)/covered.length)-Math.round(r.paise*i/covered.length);reference=r.id;source=r.source;}
   else{if(!(Number(salary?.monthly_ctc)>0)){issues.add(`HO ${p.code}: monthly People salary is missing for ${month}.`);continue;}const monthly=Math.round(Number(salary.monthly_ctc)*100);gross=Math.round(monthly*(index+1)/days)-Math.round(monthly*index/days);reference=salary.id;source='HO salary accrual';}
   const already=shared.get(`${identity}:${date}`)??0,remaining=Math.max(0,gross-already);if(!remaining)continue;
   if(actual.length)consumedPayroll.set(actual[0].id,(consumedPayroll.get(actual[0].id)??0)+remaining);
   const id=`ho-salary:${identity}:${station}`,existing=entries.get(id);
   if(existing){existing.paise+=remaining;if(existing.source!==source)existing.source='HO payroll and salary accrual';}else entries.set(id,{id,month,station,sourceStation:station,side:'expense',head:'HO salaries',description:`${p.name} · ${p.code} · ${p.role} · remaining cost after direct station allocations`,paise:remaining,source,reference:identity,date:dates[dates.length-1],details:[]});
   entries.get(id)!.details!.push({date,paise:remaining,reference,label:`${p.name} · total ₹${(gross/100).toFixed(2)} less directly assigned ₹${(already/100).toFixed(2)}`});
  }
 }
 return {entries:[...entries.values()],issues:[...issues],consumedPayroll};
}

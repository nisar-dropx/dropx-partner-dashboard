import type { InsightFact } from './insight-email';
import { storeHealthMetricDefinitions } from './store-health-scorecard';
type Store={id:string;station_code:string;station_name?:string|null;city?:string|null;owner?:string};
type Health={station_code:string;report_date:string;created_at?:string;values_json:any};
export function storeInsightFacts(stores:Store[], health:Health[], activities:{shifts:any[];days:any[];actions:any[]},date:string) {
 const facts:InsightFact[]=[];
 const previousDay=new Date(Date.parse(date)-86400000).toISOString().slice(0,10), expectedHealth=new Date(Date.parse(date)-2*86400000).toISOString().slice(0,10);
 for(const store of stores){
  const base={storeCode:store.station_code,storeName:store.station_name||'',city:store.city||'',owner:store.owner};
  const byDate=new Map<string,Health>();
  for(const row of [...health].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')))if(row.station_code===store.station_code&&row.report_date<=expectedHealth&&!byDate.has(row.report_date))byDate.set(row.report_date,row);
  const history=[...byDate.values()].sort((a,b)=>a.report_date.localeCompare(b.report_date)),latest=history.at(-1),v=latest?.values_json;
  const href=`/performance/review-status?station=${encodeURIComponent(store.id)}&from=${latest?.report_date||expectedHealth}&to=${latest?.report_date||expectedHealth}`;
  if(!latest){facts.push({...base,id:`${store.id}:missing-health`,topic:'Data coverage',label:'Store Health',value:'No imported scorecard',detail:`Expected performance date ${expectedHealth}. Missing data is not a zero score.`,period:expectedHealth,href,sentiment:'attention'});}
  else {
   const fresh=latest.report_date===expectedHealth;
   facts.push({...base,id:`${store.id}:health`,topic:'Store Health',label:`${v.band||'Reported'} · Store Health score`,value:v.score_pct==null?'Not scored':`${v.score_pct}%`,detail:`${v.points_earned??'?'} / ${v.points_available??'?'} available points. ${fresh?'Latest expected performance day.':`Latest available ${latest.report_date}; expected ${expectedHealth}. Do not call this current.`}`,period:latest.report_date,href,sentiment:!fresh||v.band==='Critical'?'attention':v.band==='Healthy'?'good':'neutral',bars:history.slice(-3).filter(r=>Number.isFinite(r.values_json?.score_pct)).map(r=>({label:r.report_date.slice(5),value:r.values_json.score_pct}))});
   // Keep source text and status: some percentages have critical qualifiers and some numeric fields are audit dates.
   const metrics=storeHealthMetricDefinitions.map(d=>({d,m:v.metrics?.[d.key]})).filter(x=>x.m?.scored===true);
   const chosen=[...metrics.filter(x=>x.m.status==='Red').sort((a,b)=>b.d.weight-a.d.weight).slice(0,3),...metrics.filter(x=>x.m.status==='Green').slice(0,1)];
   for(const {d,m} of chosen)facts.push({...base,id:`${store.id}:${d.key}`,topic:d.category,label:d.label,value:String(m.actual_text),detail:`Source status ${m.status} · target ${m.target_text}. ${fresh?'':`Older scorecard; expected ${expectedHealth}. `}Qualifiers and embedded dates belong to the source.`,period:latest.report_date,href,sentiment:!fresh||m.status==='Red'?'attention':'good'});
  }
  const shifts=activities.shifts.filter(r=>r.location_id===store.id&&r.shift_date<=previousDay&&!['cancelled','accepted'].includes(r.status));
  const days=activities.days.filter(r=>r.location_id===store.id&&r.work_date<=previousDay&&r.status==='open');
  facts.push({...base,id:`${store.id}:handover`,topic:'Shift handover',label:'Recorded handovers awaiting closure',value:String(shifts.length),detail:`${shifts.filter(r=>r.status==='submitted').length} awaiting acceptance; ${shifts.filter(r=>['open','rejected'].includes(r.status)).length} open or returned. Counts include older pending records; zero does not establish every expected shift was created.`,period:`Through ${previousDay}`,href:`/si-handover/report?from=${previousDay}&to=${previousDay}`,sentiment:shifts.length?'attention':'neutral'});
  facts.push({...base,id:`${store.id}:store-ops`,topic:'Store routines',label:'Recorded checklists not submitted',value:String(days.length),detail:'Open records through the previous day. Not submitted does not prove the work was not done; missing checklists are not counted.',period:`Through ${previousDay}`,href:'/store-ops',sentiment:days.length?'attention':'neutral'});
  const actions=activities.actions.filter(r=>r.station_id===store.id&&!['done','closed','completed','cancelled'].includes(r.status)&&r.due_date&&r.due_date<date);
  if(actions.length)facts.push({...base,id:`${store.id}:actions`,topic:'Follow-through',label:'Overdue review actions',value:String(actions.length),detail:actions.slice(0,3).map(r=>`${r.title} · ${r.owner_label||'Owner not assigned'} · due ${r.due_date}`).join('; '),period:`As of ${date}`,href,sentiment:'attention'});
 }
 return facts;
}

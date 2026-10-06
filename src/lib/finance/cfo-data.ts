import 'server-only';
import type {FinanceContext} from './data';
import {loadRent} from './data';
import {loadPnl} from './pnl-data';
import {pnlFilters,cpsMonthSlices,type PnlQuery} from './pnl';
import {loadBusinessMaster,loadNowVolumes,locationModel} from './business-master';
import {loadFinanceCpsEvidence} from '../ops-pulse/cps-data';
import {nowRevenue,dateRange,effectiveOn,accrueMonthly,contractDaily,roundMoney,type NowRate,type NowStore,type CostContract,type OverheadRule} from './now';
import {equalShares,type CfoDay,type OverheadLine,type CfoLine} from './cfo';
import {stationGroupKey} from './pnl-comparison';
export async function loadCfo(c:FinanceContext,query:PnlQuery){
 const filters=pnlFilters(query),from=filters.from,to=filters.to;
 const operating=c.locations.filter(l=>!l.is_ho&&!l.hide_from_location_list),normal=operating.filter(l=>locationModel(l)!=='NOW'),now=operating.filter(l=>locationModel(l)==='NOW');
 const [masters,volumes,rents,pnl,source,ho,hoCosts]=await Promise.all([
  loadBusinessMaster(c),loadNowVolumes(c,from,to),loadRent(c),
  loadPnl({...c,locations:normal},{period:'custom',from,to}),
  operating.length?loadFinanceCpsEvidence(c.companyId,from,to,operating.map(l=>l.station_code)):Promise.resolve({report:{daily:[],breakup:[],gaps:[]},evidence:{staff:[],associates:[]}}),
  c.authorization.hasAllLocationAccess?c.db.rpc('finance_ho_people',{p_company:c.companyId,p_from:from,p_through:to}):Promise.resolve({data:{people:[],salaries:[],assignments:[]},error:null}),
  c.authorization.hasAllLocationAccess?c.db.rpc('ops_cps_base_v2',{p_company:c.companyId,p_from:from,p_through:to,p_stations:c.locations.filter(l=>l.is_ho).map(l=>l.station_code)}):Promise.resolve({data:{breakup:[]},error:null}),
 ]);
 if(ho.error||hoCosts.error)throw Error('HO People costs could not be loaded. Please retry.');
 const locationByCode=new Map(operating.map(l=>[l.station_code,l]));
 const byKind=(kind:string)=>masters.filter(r=>r.kind===kind);
 const issues:string[]=[];if(pnl.costError)issues.push(pnl.costError);
 if(!c.authorization.hasAllLocationAccess)issues.push('This location view excludes company-wide HO allocations; business net profit requires company-wide Finance access.');
 const lines:CfoLine[]=[],days:CfoDay[]=[],overhead:OverheadLine[]=[],nowDetails:any[]=[];
 const latestReports=source.report.daily.filter(d=>d.shipment_present).map(d=>d.work_date).sort();
 // Use the same observed cutoff for newly accrued HO costs. Missing locations stay visible as gaps.
 const commonThrough=latestReports.at(-1)||volumes.map(v=>v.through_date).sort().at(-1)||to;
 const cutoff=commonThrough<to?commonThrough:to;
 for(const d of pnl.days){const l=locationByCode.get(d.station);if(!l)continue;const parent=locationByCode.get(stationGroupKey(l))||l;days.push({station:stationGroupKey(l),name:parent.station_name||parent.station_code,model:locationModel(parent),region:parent.region||parent.state||'Unassigned',city:parent.city||'Unassigned',date:d.date,unit:'shipments',volume:d.deliveries,revenue:d.revenue,cost:d.cost,regional:0,da:d.da,utr:d.utr,van:d.van,rent:d.rent,other:d.other,contracts:0,issues:d.issues});}
 const costs=new Map(source.report.daily.map(d=>[d.station_code+'/'+d.work_date,d]));
 for(const l of now)for(const slice of cpsMonthSlices(from,cutoff)){
  const maps=byKind('now_store').filter(r=>r.data.station_code===l.station_code);
  const volume=volumes.find(v=>v.station_code===l.station_code&&v.month===slice.from.slice(0,7))||null;
  for(const rate of byKind('now_rate')){let end=rate.data.mg_upd;for(const band of rate.data.slabs){if(band.above>end)issues.push(`${rate.label}: UPD ${end+1}–${band.above} has no supplied rate`);end=band.upto??Infinity;}}
  const calculated=new Map<string,ReturnType<typeof nowRevenue>['daily'][number]>(),storeIssues=new Set<string>();
  for(const map of maps){const store=map.data as NowStore,rate=byKind('now_rate').find(r=>r.key===store.rate_key)?.data as NowRate|undefined;if(!rate){storeIssues.add('Amazon Now rate card is missing');continue;}const result=nowRevenue(rate,store,volume,slice.from,slice.to);for(const d of result.daily)calculated.set(d.date,d);result.issues.forEach(x=>storeIssues.add(x));if(result.daily.length)nowDetails.push({station:l.station_code,month:slice.from.slice(0,7),category:store.category,rateLabel:byKind('now_rate').find(r=>r.key===store.rate_key)?.label,slabs:rate.slabs,...result});}
  if(!maps.length)storeIssues.add('Amazon Now category and rate mapping are missing');
  for(const date of dateRange(slice.from,slice.to)){
   const r=calculated.get(date),cost=costs.get(l.station_code+'/'+date);
   if(volume&&date>volume.through_date)continue;
   const rowIssues=[...storeIssues];if(!r)rowIssues.push('No effective Amazon Now pricing');if(!cost)rowIssues.push('Operating cost source unavailable');
   days.push({station:l.station_code,name:l.station_name||l.station_code,model:'Amazon Now '+(maps.find(m=>effectiveOn(m.data as NowStore,date))?.data.category||'Unclassified'),region:l.region||l.state||'Unassigned',city:l.city||'Unassigned',date,unit:'units',volume:r?.units??null,revenue:r?.revenue??null,cost:cost?.total??null,regional:0,da:cost?.da||0,utr:cost?.utr||0,van:cost?.van||0,rent:cost?.rent||0,other:(cost?.other||0)+(cost?.overhead||0),contracts:0,issues:rowIssues});
  }
 }
 for(const l of now){if(!byKind('contract').some(r=>r.data.station_code===l.station_code&&effectiveOn(r.data as CostContract,cutoff)))issues.push(`${l.station_code}: outsourced contracts not entered; confirm security, housekeeping and other agreed costs`);}
 const covered=new Set(days.filter(d=>d.cost!==null||d.revenue!==null).map(d=>d.station+'/'+d.date));
 const group=(code:string)=>{const l=locationByCode.get(code);return l?stationGroupKey(l):code;};
 const contracts=byKind('contract').map(r=>({...r.data,label:r.label}) as CostContract&{label:string});
 const existing=pnl.costs.concat(source.report.breakup.filter(b=>now.some(l=>l.station_code===b.station_code)));
 for(const b of existing){if(!covered.has(group(b.station_code)+'/'+b.work_date))continue;
  const replaces=contracts.some(x=>x.station_code===b.station_code&&effectiveOn(x,b.work_date)&&x.settlement_heads.some(h=>h.toLowerCase()===b.sub_head.toLowerCase())&&['Cashbook','Approved payment requests'].includes(b.source));
  if(replaces){const d=days.find(d=>d.station===group(b.station_code)&&d.date===b.work_date&&d.cost!==null);if(d){d.cost=roundMoney(d.cost!-b.amount);const k=b.head==='DA'?'da':b.head==='UTR'?'utr':b.head==='Van'?'van':b.head==='Rent'?'rent':'other';d[k]=roundMoney(d[k]-b.amount);}}else lines.push({station:group(b.station_code),date:b.work_date,head:b.sub_head,source:b.source,amount:b.amount,basis:b.station_code});
 }
 for(const contract of contracts)for(const date of dateRange(from,cutoff)){
  if(!locationByCode.has(contract.station_code))continue;const d=days.find(d=>d.station===group(contract.station_code)&&d.date===date&&d.cost!==null);if(!d)continue;const amount=contractDaily(contract,date);if(!amount)continue;d.cost=roundMoney(d.cost!+amount);d.contracts=roundMoney(d.contracts+amount);lines.push({station:d.station,date,head:contract.label,source:'Finance contract',amount,basis:`${contract.vendor} · ₹${contract.amount} / ${contract.frequency} · ${contract.reference}`});
 }
 // Full HO payroll less the exact People cost already shared into operating locations.
 const assigned=new Map<string,number>();for(const d of source.evidence.staff){if(!covered.has(group(d.station_code)+'/'+d.date))continue;const key=d.person_id+'/'+d.date;assigned.set(key,(assigned.get(key)||0)+d.amount);}
 const people=ho.data?.people||[],salaries=ho.data?.salaries||[],assignments=ho.data?.assignments||[];
 const hoRules=byKind('overhead');
 const hoLocation=(code:string)=>c.locations.find(l=>l.station_code===code&&l.is_ho);
 function addHo(line:Omit<OverheadLine,'mode'|'recipients'>){
  const rule=hoRules.find(r=>r.data.station_code===line.station&&effectiveOn(r.data as OverheadRule,line.date))?.data as OverheadRule|undefined;
  const recipients=rule?.mode==='regional'?rule.recipient_codes:[];
  const row:OverheadLine={...line,mode:rule?.mode==='regional'&&!recipients.length?'unallocated':rule?.mode||'unallocated',recipients};overhead.push(row);
  if(!rule||(rule.mode==='regional'&&!recipients.length)){issues.push(`${line.station}: overhead allocation is not configured; retained as unallocated business cost`);return;}
  if(rule.mode==='regional')for(const [code,amount] of Object.entries(equalShares(line.amount,recipients))){const d=days.find(d=>d.station===group(code)&&d.date===line.date&&d.cost!==null);if(d)d.regional=roundMoney(d.regional+amount);else if(amount)overhead.push({...row,head:'Unallocated regional share',name:code,amount,mode:'unallocated',gross:0,alreadyAllocated:0,recipients:[],issue:'Recipient has no covered operating data'});}
 }
 for(const p of people)for(const date of dateRange(from,cutoff)){
  if((p.date_of_join&&p.date_of_join>date)||(p.last_working_date&&p.last_working_date<date)||(p.deleted_at&&p.deleted_at.slice(0,10)<=date)||(p.is_active===false&&!(p.last_working_date&&p.last_working_date>=date)))continue;
  const home=assignments.filter((a:any)=>a.person_id===p.id&&effectiveOn(a,date)).sort((a:any,b:any)=>b.effective_from.localeCompare(a.effective_from))[0];
  const station=home?home.station_code:p.station_code;if(!hoLocation(station))continue;
  const salary=salaries.filter((s:any)=>s.person_id===p.id&&effectiveOn(s,date)).sort((a:any,b:any)=>b.effective_from.localeCompare(a.effective_from)||String(b.id).localeCompare(String(a.id)))[0];
  const monthly=salary?.monthly_ctc==null?null:Number(salary.monthly_ctc),gross=monthly===null?0:accrueMonthly(String(monthly),date),already=roundMoney(assigned.get(p.id+'/'+date)||0),residual=Math.max(0,roundMoney(gross-already));
  addHo({station,date,head:'People CTC',name:p.name,code:p.code,monthly,gross,alreadyAllocated:already,amount:residual,...(monthly===null?{issue:'Monthly CTC missing'}:{})});
 }
 for(const r of rents.filter(r=>hoLocation(r.allocation_station_code)))for(const date of dateRange(from,cutoff))if(effectiveOn(r,date)){const monthly=Number(r.monthly_rent)+Number(r.monthly_maintenance),amount=accrueMonthly(String(monthly),date);addHo({station:r.allocation_station_code,date,head:'HO rent & maintenance',name:r.payee_name,code:r.site_code,monthly,gross:amount,alreadyAllocated:0,amount});}
 for(const x of contracts.filter(x=>hoLocation(x.station_code)))for(const date of dateRange(from,cutoff)){const amount=contractDaily(x,date);if(amount)addHo({station:x.station_code,date,head:x.label,name:x.vendor,code:x.reference,monthly:x.frequency==='monthly'?Number(x.amount):null,gross:amount,alreadyAllocated:0,amount});}
 for(const line of hoCosts.data?.breakup||[]){if(line.work_date>cutoff||line.head==='Rent')continue;if(contracts.some(x=>x.station_code===line.station_code&&effectiveOn(x,line.work_date)&&x.settlement_heads.some(h=>h.toLowerCase()===line.sub_head.toLowerCase())))continue;addHo({station:line.station_code,date:line.work_date,head:line.sub_head,name:line.source,code:'',monthly:null,gross:line.amount,alreadyAllocated:0,amount:line.amount});}
 for(const l of c.locations.filter(l=>l.is_ho))if(!rents.some(r=>r.allocation_station_code===l.station_code&&effectiveOn(r,cutoff)))issues.push(`${l.station_code}: no effective HO rent record (confirm if rent-free)`);
 for(const d of source.report.gaps||[])if(now.some(l=>l.station_code===d.station_code))issues.push(`${d.station_code}: ${d.kind}`);
 return {days,lines,overhead,nowDetails,issues:[...new Set(issues)],filters,cutoff,allAccess:c.authorization.hasAllLocationAccess,readAt:new Date().toISOString(),insightsEnabled:byKind('insight').some(r=>r.data.enabled),locations:operating.map(l=>({code:l.station_code,name:l.station_name,model:locationModel(l),region:l.region||l.state||'Unassigned',city:l.city||'Unassigned'}))};
}
export type CfoReport=Awaited<ReturnType<typeof loadCfo>>;

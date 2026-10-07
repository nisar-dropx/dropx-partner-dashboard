import 'server-only';
import {requireCompanyId} from '@/lib/company-scope';
import type {AuthorizationContext} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {loadCodLocations,locationModelName,todayKolkata} from './cod';
import {loadCpsSnapshot} from './cps-snapshot';
import {cpsPeriod,type CpsParams} from './cps';
import {contractDaily,effectiveOn,roundMoney,type CostContract,type NowVolume} from '@/lib/finance/now';
export async function darkStoreScope(a:AuthorizationContext){
 const companyId=requireCompanyId(a);if(!supabaseAdmin)throw Error('Data is temporarily unavailable.');
 const r=await loadCodLocations(companyId,a.locationScopeIds,a.hasAllLocationAccess);if(r.error)throw Error('Location access could not be loaded.');
 return {companyId,db:supabaseAdmin,locations:r.locations.filter(l=>!l.is_ho&&!l.hide_from_location_list&&locationModelName(l).toUpperCase()==='NOW')};
}
export async function loadCpu(a:AuthorizationContext,params:CpsParams){
 const c=await darkStoreScope(a),period=cpsPeriod(params,todayKolkata());
 const selected=c.locations.filter(l=>!params.station||l.station_code===params.station);
 if(params.station&&!selected.length)throw Error('This store is outside your authorized access.');
 if(!selected.length)return {period,locations:c.locations,rows:[]};
 const codes=selected.map(l=>l.station_code);
 const [snapshot,v,m]=await Promise.all([
  loadCpsSnapshot(c.companyId,period.from,period.to,selected),
  readAllRows(c.db.from('finance_now_volumes').select('station_code,month,through_date,units,revision').eq('company_id',c.companyId).in('station_code',codes).gte('month',period.from.slice(0,7)+'-01').lte('month',period.to.slice(0,7)+'-01').order('month').order('station_code')),
  readAllRows(c.db.from('finance_business_master').select('kind,key,label,data').eq('company_id',c.companyId).is('deleted_at',null).in('kind',['contract','now_store']).order('id'))
 ]);if(v.error||m.error)throw Error('Store units or contract costs could not be loaded.');
 const contracts=(m.data||[]).filter(r=>r.kind==='contract').map(r=>({...r.data,label:r.label}) as CostContract&{label:string});
 const rows=selected.map(l=>{
  const days=snapshot.daily.filter(d=>d.station_code===l.station_code).filter(d=>{const volume=v.data?.find(x=>x.station_code===l.station_code&&x.month.slice(0,7)===d.work_date.slice(0,7));return !volume||d.work_date<=volume.through_date;});
  const dates=new Set(days.map(d=>d.work_date));
  const lines=snapshot.breakup.filter(b=>b.station_code===l.station_code&&dates.has(b.work_date)&&!contracts.some(x=>x.station_code===b.station_code&&effectiveOn(x,b.work_date)&&['Cashbook','Approved payment requests'].includes(b.source)&&x.settlement_heads.some(h=>h.toLowerCase()===b.sub_head.toLowerCase()))).map(b=>({date:b.work_date,head:b.head==='UTR'?'Store team':b.sub_head,source:b.source,amount:b.amount}));
  for(const contract of contracts.filter(x=>x.station_code===l.station_code))for(const date of dates){const amount=contractDaily(contract,date);if(amount)lines.push({date,head:contract.label,source:'Finance contract',amount});}
  let units=0,missing=false;for(const date of dates){const volume=v.data?.find(x=>x.station_code===l.station_code&&x.month.slice(0,7)===date.slice(0,7));if(!volume)missing=true;else units+=Number(volume.units)/Number(volume.through_date.slice(8));}
  const groups=Object.values(lines.reduce<Record<string,{head:string;amount:number;lines:typeof lines}>>((acc,x)=>{const row=acc[x.head]??={head:x.head,amount:0,lines:[]};row.amount+=x.amount;row.lines.push(x);return acc;},{}));
  const cost=roundMoney(lines.reduce((s,x)=>s+x.amount,0)),unitCount=missing?null:units;
  return {code:l.station_code,name:l.station_name,city:l.city,category:m.data?.find(r=>r.kind==='now_store'&&r.data.station_code===l.station_code&&effectiveOn(r.data,period.to))?.data.category||'Not mapped',units:unitCount,cpu:unitCount&&unitCount>0?cost/unitCount:null,cost,days:dates.size,through:[...dates].sort().at(-1)||null,groups:groups.map(g=>({...g,amount:roundMoney(g.amount),cpu:unitCount&&unitCount>0?g.amount/unitCount:null})),notes:[...(missing?['Monthly unit count is not entered.']:[]),...(!contracts.some(x=>x.station_code===l.station_code)?['Confirm outsourced contracts in Finance Master.']:[])]};
 });return {period,locations:c.locations,rows};
}

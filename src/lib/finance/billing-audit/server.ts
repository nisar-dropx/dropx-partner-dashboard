import 'server-only';
import type {FinanceContext} from '../data';
import {loadPnl} from '../pnl-data';
import {locationModel} from '../business-master';
import {worker} from '../final-pnl/server';
import {baseStations} from '../final-pnl/model';
import {reconcileBilling,type BillingSource,type Station} from './model';
export async function loadBillingAudit(ctx:FinanceContext,month:string){
 const read=async(table:string,columns:string)=>{
  const rows:any[]=[];
  for(let offset=0;offset<10000;offset+=1000){const r=await ctx.db.from(table).select(columns).eq('company_id',ctx.companyId).order(table==='stations'?'id':'location_id').range(offset,offset+999);if(r.error)throw Error('Station mapping could not be loaded.');rows.push(...r.data);if(r.data.length<1000)return rows;}
  throw Error('Station mapping exceeds the supported limit.');
 };
 const [source,topology,aliases,liveResult]=await Promise.all([
  worker<BillingSource>(ctx.companyId,`billing-audit?month=${month}`),
  read('stations','id,station_code,parent_station_id,is_ho,is_active,hide_from_location_list,region,location_models(code,name)'),
  read('cod_station_settings','location_id,portal_station_code'),
  loadPnl({...ctx,locations:ctx.locations.filter(l=>locationModel(l)!=='NOW')},{period:'month',month,provider:'Amazon'},Promise.resolve({daily:[],breakup:[],generated_at:new Date().toISOString()})).then(data=>({data,error:''})).catch(()=>({data:null,error:'Live shipment counts and rate cards could not be loaded. Workbook and invoice values remain available; provisional values are unavailable.'})),
 ]);
 const stations:Station[]=baseStations(topology,aliases).map(s=>{
  const own=topology.find(t=>t.station_code===s.code)!;
  const parent=topology.find(t=>t.station_code===s.base)??own;
  const model=Array.isArray(parent.location_models)?parent.location_models[0]:parent.location_models;
  return {...s,active:[own,parent].every(t=>t.is_active!==false&&!t.is_ho&&!t.hide_from_location_list),region:parent.region||'Unassigned',model:model?.code||'Unassigned'};
 });
 return {month,source,rows:reconcileBilling(source,liveResult.data,stations),liveError:liveResult.error,readAt:new Date().toISOString()};
}

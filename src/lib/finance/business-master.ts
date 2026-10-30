import 'server-only';
import type { FinanceContext } from './data';
import type { MasterRecord, NowVolume } from './now';
export const locationModel = (l: FinanceContext['locations'][number]) => (Array.isArray(l.location_models)?l.location_models[0]:l.location_models)?.code?.toUpperCase() || 'Unassigned';
export async function loadBusinessMaster(c:FinanceContext) {
  const rows:MasterRecord[]=[];
  for(let offset=0;;offset+=1000){
    const r=await c.db.from('finance_business_master').select('id,kind,key,label,data,revision,deleted_at,updated_at').eq('company_id',c.companyId).is('deleted_at',null).order('key').range(offset,offset+999);
    if(r.error)throw Error('Business masters could not be loaded. Please retry.'); rows.push(...r.data as MasterRecord[]);if(r.data.length<1000)break;
  }
  return rows;
}
export async function loadNowVolumes(c:FinanceContext,from:string,to:string):Promise<NowVolume[]> {
  const codes=c.locations.filter(l=>locationModel(l)==='NOW').map(l=>l.station_code);if(!codes.length)return [];
  const rows:NowVolume[]=[];
  for(let offset=0;;offset+=1000){const r=await c.db.from('finance_now_volumes').select('station_code,month,through_date,units,incentive_percent,note,revision').eq('company_id',c.companyId).in('station_code',codes).gte('month',from.slice(0,7)+'-01').lte('month',to.slice(0,7)+'-01').order('month').order('station_code').range(offset,offset+999);if(r.error)throw Error('Store units could not be loaded.');rows.push(...r.data.map(v=>({...v,month:v.month.slice(0,7)})));if(r.data.length<1000)break;}return rows;
}

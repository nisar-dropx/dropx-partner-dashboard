import {hasPermission,type AuthorizationContext} from './authorization';
import {loadOpsWorkforceLocations} from './ops-workforce-locations';
import {supabaseAdmin} from './supabase-admin';
type Rel<T>=T|T[]|null;
export function amazonDeskLocation(s:{providers?:Rel<{name?:string|null;code?:string|null}>;location_models?:Rel<{name?:string|null;code?:string|null}>}){const p=Array.isArray(s.providers)?s.providers[0]:s.providers,m=Array.isArray(s.location_models)?s.location_models[0]:s.location_models;return /amazon/i.test(p?.name||p?.code||'')&&['EDSP','XPT','AMXL'].includes((m?.code||m?.name||'').toUpperCase().replace(/[ _-]/g,''));}
const cache=new Map<string,{at:number;result:Promise<{count:number;href:string;checkedAt:string|null}>}>();
export async function loadAmazonDaAttention(auth:AuthorizationContext,selectedIds?:string[]){
 if(!auth.companyId||!hasPermission(auth,'ops_amazon_da','access'))return null;
 const stations=(await loadOpsWorkforceLocations(auth.companyId,auth)).filter(s=>amazonDeskLocation(s)&&(!selectedIds||selectedIds.includes(s.id)));
 if(!stations.length)return null;
 const ids=stations.map(s=>s.id).sort(),key=auth.companyId+':'+ids.join(',');const saved=cache.get(key);if(saved&&Date.now()-saved.at<30000)return saved.result;
 const result=(async()=>{if(!supabaseAdmin)throw Error('Unavailable');let count=0;const pendingStations=new Set<string>();let checkedAt:string|null=null;
  for(let from=0;;from+=500){const r=await supabaseAdmin.from('amazon_da_detail_snapshots').select('provider_id,station_id,idfy,idfy_at,request_block_ids').eq('company_id',auth.companyId!).in('station_id',ids).eq('enabled',true).order('provider_id').range(from,from+499);if(r.error)throw Error('IDfy status unavailable');for(const row of r.data||[]){if(row.request_block_ids!==null?row.request_block_ids.length>0:row.idfy?.checks?.some((c:{needsResponse?:boolean})=>c.needsResponse)){count++;pendingStations.add(row.station_id);}if(row.idfy_at&&(!checkedAt||row.idfy_at<checkedAt))checkedAt=row.idfy_at;}if((r.data||[]).length<500)break;}
  const p=new URLSearchParams({tab:'amazon',view:'bgc-pending',stations:[...(pendingStations.size?pendingStations:new Set(ids))].join(',')});return {count,href:'/workforce/onboarding?'+p,checkedAt};})();
 cache.set(key,{at:Date.now(),result});result.catch(()=>cache.delete(key));for(const [k,v] of cache)if(Date.now()-v.at>30000)cache.delete(k);return result;
}

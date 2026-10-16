import {getAuthorization} from '@/lib/authorization';
import {mappingAdmin} from '@/lib/fleet/da-mapping-client';
import {mappingStationScope,mappingPeopleClusters} from '@/lib/fleet/da-mapping-server';
import {FleetReportError} from '@/lib/fleet/report-data';
import {istDate,validDate} from '@/lib/fleet/daily-report';
import {previousMappingDate} from '@/lib/fleet/da-mapping';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{
  const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
  const scope=await mappingStationScope(auth),p=new URL(request.url).searchParams,latest=previousMappingDate(istDate());
  const from=p.get('from')||latest.slice(0,8)+'01',to=p.get('to')||latest;
  if(!validDate(from)||!validDate(to)||from>to||to>latest||Date.parse(to)-Date.parse(from)>365*86400000)throw new FleetReportError('Choose up to one year, ending yesterday or earlier.',400);
  const list=(key:string)=>{const a=p.getAll(key);if(a.length>200||a.some(x=>x.length>150))throw new FleetReportError('Too many filter selections.',400);return a;};
  const selected=list('station'),regions=list('region'),clusters=list('cluster');
  if(selected.some(c=>!scope.stations.some(s=>s.code===c)))throw new FleetReportError('Station is outside your scope.',403);
  const hierarchy=await mappingPeopleClusters(scope.companyId,scope.stations.map(s=>s.id));
  if(clusters.length&&hierarchy.error)throw new FleetReportError('People cluster mapping is unavailable. Retry or clear the cluster filter.',503);
  const stations=scope.stations.map(s=>({...s,clusters:hierarchy.error?null:(hierarchy.byLocation.get(s.id)?.clusterManagers??[]).map(c=>({id:c.personId,name:c.name}))}));
  const codes=stations.filter(s=>(!selected.length||selected.includes(s.code))&&(!regions.length||regions.includes(s.region||'__none'))&&(!clusters.length||(s.clusters?.length?s.clusters.some(c=>clusters.includes(c.id)):clusters.includes('__none')))).map(s=>s.code);
  const page=Number(p.get('page')||0),sort=p.get('sort')||'delivered',direction=p.get('direction')||'desc',group=p.get('group')||'vehicle',vehicleId=p.get('vehicleId')||'';
  if(!Number.isInteger(page)||page<0||page>10000||!['vehicle','station','date','delivered','c_return','swa','pending_days','days'].includes(sort)||!['asc','desc'].includes(direction)||!['vehicle','day'].includes(group)||vehicleId&&!/^[0-9a-f-]{36}$/i.test(vehicleId))throw new FleetReportError('Invalid report options.',400);
  const result=await mappingAdmin!.rpc('fleet_da_delivery_report',{p_company:scope.companyId,p_stations:codes,p_from:from,p_to:to,p_filters:{query:(p.get('query')||'').slice(0,150),vehicleId,sources:list('source'),models:list('model'),statuses:list('status')},p_offset:page*50,p_limit:50,p_group:group,p_sort:sort,p_direction:direction});
  if(result.error){console.error('DA delivery report failed',result.error.code);throw new FleetReportError('Delivery report could not be loaded. Retry; mappings are unchanged.',503);}
  return Response.json({...result.data,from,to,latestWorkDate:latest,stations,page,pageSize:50,clusterWarning:hierarchy.error?'People cluster details are temporarily unavailable.':undefined},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return Response.json({error:e instanceof FleetReportError?e.message:'Unable to load delivery report.'},{status:e instanceof FleetReportError?e.status:500});}
}

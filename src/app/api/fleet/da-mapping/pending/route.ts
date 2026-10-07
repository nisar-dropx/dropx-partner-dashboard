import {readAllRows} from '@/lib/supabase-pagination';
import {getAuthorization} from '@/lib/authorization';
import {mappingAdmin} from '@/lib/fleet/da-mapping-client';
import {mappingStationScope} from '@/lib/fleet/da-mapping-server';
import {FleetReportError} from '@/lib/fleet/report-data';
import {istDate,validDate} from '@/lib/fleet/daily-report';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{
  const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
  const scope=await mappingStationScope(auth),p=new URL(request.url).searchParams;
  const station=p.get('station')||'',from=p.get('from'),to=p.get('to'),offset=Number(p.get('offset')||0);
  if((from&&(!validDate(from)||from>istDate()))||(to&&(!validDate(to)||to>istDate()))||(from&&to&&from>to)||!Number.isSafeInteger(offset)||offset<0)throw new FleetReportError('Choose a valid date range.',400);
  if(station&&!scope.stations.some(s=>s.code===station))throw new FleetReportError('Station is outside your scope.',403);
  const result=await mappingAdmin!.rpc('fleet_pending_da_days',{p_company:scope.companyId,p_stations:scope.stations.filter(s=>!station||s.code===station).map(s=>s.code),p_from:from,p_to:to,p_offset:offset,p_limit:20});
  if(result.error)throw new FleetReportError('Pending mappings could not be checked. Retry; mapping submission remains available.',503);
  const choices=scope.stations.length?await readAllRows(mappingAdmin!.from('fleet_da_mapping_periods').select('station_code,vehicle_id,effective_from').eq('company_id',scope.companyId).in('station_code',scope.stations.map(s=>s.code)).eq('eligible',true).order('vehicle_id').order('effective_from')):{data:[],error:null};
  if(choices.error)throw new FleetReportError('Pending location filters could not be loaded. Retry.',503);
  const codes=new Set((choices.data??[]).map(s=>s.station_code));
  return Response.json({...result.data,stations:scope.stations.filter(s=>codes.has(s.code)),offset},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return Response.json({error:e instanceof FleetReportError?e.message:'Pending mappings could not be checked. Retry.'},{status:e instanceof FleetReportError?e.status:503});}
}

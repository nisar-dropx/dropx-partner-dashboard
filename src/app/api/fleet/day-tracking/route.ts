import {getAuthorization} from '@/lib/authorization';
import {validateReportRange} from '@/lib/fleet/daily-report';
import {loadDayTracking} from '@/lib/fleet/day-tracking-server';
import {FleetReportError} from '@/lib/fleet/report-data';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
 const p=new URL(request.url).searchParams,from=p.get('from')??'',to=p.get('to')??'';
 const error=validateReportRange(from,to);if(error)return Response.json({error},{status:400});
 try{return Response.json(await loadDayTracking(auth,from,to),{headers:{'Cache-Control':'private, no-store'}});}
 catch(e){return Response.json({error:e instanceof FleetReportError?e.message:'Unable to load day tracking.'},{status:e instanceof FleetReportError?e.status:500});}
}

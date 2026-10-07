import { getAuthorization } from '@/lib/authorization';
import { historyReportKeys, loadReportHistory, type HistoryReportKey } from '@/lib/fleet/report-history';
import { FleetReportError } from '@/lib/fleet/report-data';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request:Request) {
  const auth=await getAuthorization(); if(!auth)return Response.json({error:'Sign in again.'},{status:401});
  const params=new URL(request.url).searchParams,key=params.get('report') as HistoryReportKey;
  if(!historyReportKeys.includes(key))return Response.json({error:'Choose a valid report.'},{status:400});
  try{return Response.json(await loadReportHistory(auth,key,params.get('from')||'',params.get('to')||''),{headers:{'Cache-Control':'private, no-store'}});}
  catch(error){return Response.json({error:error instanceof FleetReportError?error.message:'Report unavailable. Please retry.'},{status:error instanceof FleetReportError?error.status:500});}
}

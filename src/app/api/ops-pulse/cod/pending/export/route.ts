import {loadCodAgeing} from '@/lib/ops-pulse/cod-ageing-data';
import {codAgeingCsv} from '@/lib/ops-pulse/cod-ageing';
import {getAuthorization,hasPermission} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {loadCodPendingReport} from '@/lib/ops-pulse/cod-pending-data';
import {codPendingCsv,filterCodPendingRows,validReportDate} from '@/lib/ops-pulse/cod-pending';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Authentication required.'},{status:401});
 if(!hasPermission(auth,'cod_reports','access'))return Response.json({error:'COD report access required.'},{status:403});
 const p=new URL(request.url).searchParams,date=p.get('date')||'',location=p.get('location')||'';
 if(!validReportDate(date))return Response.json({error:'Choose a valid report date.'},{status:400});
 if(location&&!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(location))return Response.json({error:'Station access denied.'},{status:403});
 try{
  if(!supabaseAdmin||!auth.companyId)throw new Error('Unavailable');
  const ageing=p.get('type')==='ageing';
  const rows=filterCodPendingRows(await loadCodPendingReport(supabaseAdmin,auth.companyId,auth.locationScopeIds,auth.hasAllLocationAccess,date),{location,client:p.get('client')||'',status:ageing?'all':p.get('status')||'all'});
  let csv=codPendingCsv(rows);
  if(ageing){const detail=p.get('detail')||undefined;if(detail&&!rows.some(r=>r.station.station_code===detail))return Response.json({error:'Station access denied.'},{status:403});const source=await loadCodAgeing(supabaseAdmin,auth.companyId,date,rows.filter(r=>r.client==='amazon').map(r=>r.station.station_code));if(source.error)return Response.json({error:source.error},{status:503});csv=codAgeingCsv(source,detail);}
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="cod-${ageing?'ageing':'pending'}-${date}.csv"`,'Cache-Control':'private, no-store'}});
 }catch(error){console.error('COD pending export failed',error);return Response.json({error:'Unable to load the complete COD report. Please retry.'},{status:503});}
}

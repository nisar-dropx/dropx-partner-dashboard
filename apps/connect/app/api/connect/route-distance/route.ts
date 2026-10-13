import { NextResponse } from 'next/server';
import { requireConnectAccount, type ConnectAccount } from '@/lib/connect-auth';
import { resolveCanonicalPaymentWorker } from '@/lib/direct-workforce-payment-data';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
  try{
    const query=new URL(request.url).searchParams;
    const account=await requireConnectAccount(query.get('profileType') as ConnectAccount['profileType'],query.get('accountId')||'');
    if(account.workspace!=='workforce'||!account.pageAccess.includes('earnings'))return NextResponse.json({error:'Not available'},{status:403,headers});
    const workforce=await resolveCanonicalPaymentWorker(account),routeId=query.get('routeId')||'';
    if(!supabaseAdmin||!workforce?.id||!/^[a-f0-9-]{36}$/.test(routeId))return NextResponse.json({error:'Route not found'},{status:404,headers});
    const result=await supabaseAdmin.from('workforce_route_distances').select('work_date,status,distance_km,departure_km,delivery_km,return_km,calculated_at,route_geometry').eq('company_id',account.companyId).eq('workforce_id',workforce.id).eq('id',routeId).eq('status','ready').maybeSingle();
    if(result.error)throw new Error('Unable to load the route. Please retry.');
    if(!result.data?.route_geometry)return NextResponse.json({error:'Route map is not available for this day'},{status:404,headers});
    // Only the signed-in workforce member's route geometry; never raw Amazon
    // tasks, package identifiers, recipients, contact numbers or addresses.
    const geometry=result.data.route_geometry;
    return NextResponse.json({...result.data,route_geometry:{method:['amazon_gps','amazon_gps_roads'].includes(geometry.method)?geometry.method:'scan_roads',station:geometry.station,path:geometry.path,stops:(geometry.stops??[]).map((stop:any)=>({point:stop.point,firstScanAt:stop.firstScanAt,scanCount:stop.scanCount}))}},{headers});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Unable to load route'},{status:400,headers});}
}

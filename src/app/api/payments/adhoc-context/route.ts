import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { dateKey } from '@/lib/payment-volume';
import { loadAdhocContext } from '@/lib/adhoc-vehicle-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
 if(!hasPermission(auth,'expense_requests','add')&&!hasPermission(auth,'payment_requests','add'))return Response.json({error:'Request access denied.'},{status:403});
 const q=new URL(request.url).searchParams,location=q.get('location')||'',date=q.get('date')||'';
 if(!/^[a-f0-9-]{36}$/i.test(location)||!dateKey(date))return Response.json({error:'Select station and date.'},{status:400});
 if(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(location))return Response.json({error:'Station outside your access.'},{status:403});
 const company=requireCompanyId(auth);
 const station=await supabaseAdmin!.from('stations').select('station_code').eq('company_id',company).eq('id',location).eq('is_active',true).maybeSingle();
 if(!station.data)return Response.json({error:'Station unavailable.'},{status:404});
 try{return Response.json(await loadAdhocContext(company,station.data.station_code,date),{headers:{'Cache-Control':'private, no-store'}});}catch{return Response.json({error:'Vehicle checks unavailable. Please retry.'},{status:503});}
}

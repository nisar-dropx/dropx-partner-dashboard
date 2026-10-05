import { NextResponse } from 'next/server';
import { getAuthorization,hasPermission } from '@/lib/authorization';
import { hasActiveFleetMembership } from '@/lib/fleet-control';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const auth=await getAuthorization();
 if(!auth?.companyId)return NextResponse.json({error:'Sign in to view System Logs.'},{status:401});
 if(!supabaseAdmin)return NextResponse.json({error:'Database unavailable.'},{status:503});
 if(!(auth.isMasterOwner||await hasActiveFleetMembership(auth.companyId,auth.userId))||!(auth.isMasterOwner||hasPermission(auth,'fleet_settings','access')))return NextResponse.json({error:'Fleet Settings access is required to view System Logs.'},{status:403});
 const p=new URL(request.url).searchParams;const page=Math.max(1,Math.min(10000,Math.floor(Number(p.get('page')))||1));const size=30;
 let query=supabaseAdmin.from('fleet_system_logs').select('*',{count:'exact'}).eq('company_id',auth.companyId).order('created_at',{ascending:false}).order('id',{ascending:false});
 if(!auth.isMasterOwner&&!auth.hasAllLocationAccess){
  const stations=await supabaseAdmin.from('stations').select('station_code').eq('company_id',auth.companyId).in('id',auth.locationScopeIds.length?auth.locationScopeIds:['00000000-0000-0000-0000-000000000000']);
  if(stations.error)return NextResponse.json({error:'Could not verify location scope.'},{status:503});
  query=query.in('station_code',(stations.data??[]).map(s=>s.station_code));
 }
 for(const key of ['from','to']){const value=p.get(key);if(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return NextResponse.json({error:'Choose valid report dates.'},{status:400});query=key==='from'?query.gte('created_at',`${value}T00:00:00+05:30`):query.lte('created_at',`${value}T23:59:59.999+05:30`);}}
 if(p.get('outcome'))query=query.eq('outcome',p.get('outcome'));
 if(p.get('entity'))query=query.eq('entity',p.get('entity'));
 if(p.get('kind'))query=query.eq('event_kind',p.get('kind'));
 const search=(p.get('search')||'').replace(/[^\p{L}\p{N} .@_-]/gu,' ').trim().slice(0,100);
 if(search)query=query.or(`actor_label.ilike.%${search}%,subject.ilike.%${search}%,action.ilike.%${search}%,route.ilike.%${search}%`);
 const result=await query.range((page-1)*size,page*size-1);
 if(result.error)return NextResponse.json({error:'Unable to load System Logs.'},{status:503});
 return NextResponse.json({rows:result.data,total:result.count,page,pageSize:size},{headers:{'Cache-Control':'private, no-store'}});
}

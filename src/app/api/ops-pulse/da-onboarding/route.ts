import {NextResponse} from 'next/server';
import {getAuthorization,hasPermission} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {loadOpsWorkforceLocations} from '@/lib/ops-workforce-locations';
import {workforceStationPolicy} from '@/lib/workforce-register-policy';
import {loadDARegistry} from '@/lib/da-onboarding-data';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request){
 const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
 const auth=await getAuthorization();
 if(!auth?.companyId)return reply({error:'Sign in to continue.'},401);
 if(!hasPermission(auth,'workforce_onboarding','access'))return reply({error:'Workforce onboarding access is required.'},403);
 const amazon=hasPermission(auth,'ops_amazon_da','access'),guided=hasPermission(auth,'delivery_associates','access');
 if(!amazon&&!guided)return reply({error:'DA onboarding access is required.'},403);
 const station=new URL(request.url).searchParams.get('station');
 try{const stations=await loadOpsWorkforceLocations(auth.companyId,auth);const selected=stations.find(s=>s.id===station);
 if(!selected)return reply({error:'Select a station within your access.'},403);
 if(!workforceStationPolicy(selected).requiresStationEmail)return reply({error:'Automated onboarding is currently available for Amazon EDSP, XPT and AMXL stations.'},400);
 if(!supabaseAdmin)throw Error('Onboarding storage unavailable');
 return reply(await loadDARegistry(supabaseAdmin,auth.companyId,selected.id,amazon,guided,new URL(request.url).searchParams.get('archive')==='1'));
 }catch{return reply({error:'Could not load DA onboarding. Please retry.'},503);}
}

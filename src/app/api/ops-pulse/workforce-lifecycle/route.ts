import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission, isCompanyOwner } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { lifecycleMobile, mayManageWorkforceLifecycle, workforceLifecycleActions, type WorkforceLifecycleRow } from '@/lib/workforce-lifecycle-policy';

export const dynamic='force-dynamic';
export const maxDuration=120;
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
class AccessError extends Error { constructor(message:string,readonly status=400){super(message);} }
async function context(write=false) {
 const auth=await getAuthorization();
 if(!auth?.companyId || !supabaseAdmin) throw new AccessError('Sign in to Workforce.',401);
 if(!hasPermission(auth,'delivery_associates',write?'edit':'access')) throw new AccessError('Workforce access required.',403);
 const canManage=mayManageWorkforceLifecycle(auth,isCompanyOwner(auth));
 if(write && !canManage) throw new AccessError('Finance, the Managing Partner or National Head must approve this action.',403);
 // Exited associates can belong to a closed station. The registration picker
 // intentionally hides closed stations, but lifecycle history must retain them.
 const stationResult=await supabaseAdmin.from('stations').select('id,station_code,parent_station_id').eq('company_id',auth.companyId);
 if(stationResult.error) throw stationResult.error;
 const allStations=stationResult.data||[], allowed=new Set(auth.locationScopeIds);
 let changed=true;
 while(changed){changed=false;for(const s of allStations){if(s.parent_station_id&&allowed.has(s.parent_station_id)&&!allowed.has(s.id)){allowed.add(s.id);changed=true;}}}
 const stations=allStations.filter(s=>auth.hasAllLocationAccess||allowed.has(s.id));
 return {auth,companyId:auth.companyId,db:supabaseAdmin,stations,canManage};
}
export async function GET(request:Request) {
 try {
  const {companyId,db,stations,canManage}=await context();
  const q=new URL(request.url).searchParams, mobile=q.get('mobile');
  if(mobile!==null && !/^\d{10}$/.test(lifecycleMobile(mobile))) throw new AccessError('Enter a complete mobile number.');
  const scope=new Set(stations.map(s=>s.id));
  // Exact mobile lookup avoids running the delivery audit while typing.
  if(mobile!==null) {
   const result=await db.from('workforce').select('id,dropx_id,full_name,mobile,onboarding_status,lifecycle_status,is_active,location_id')
    .eq('company_id',companyId).is('deleted_at',null).eq('mobile',lifecycleMobile(mobile)).limit(20);
   if(result.error) throw result.error;
   return reply({matches:(result.data||[]).filter(r=>scope.has(r.location_id)).map(r=>({id:r.id,dropx_id:r.dropx_id,full_name:r.full_name,
    canRejoin:!r.is_active || ['inactive','offboarded','exited','terminated'].includes(r.lifecycle_status),status:r.lifecycle_status}))});
  }
  const result=await db.rpc('workforce_lifecycle_audit',{p_company:companyId});
  if(result.error) throw result.error;
  const rows=(result.data as WorkforceLifecycleRow[]).filter(r=>scope.has(r.location_id));
  const events=await db.from('workforce_status_events').select('id,workforce_id,action,from_status,to_status,reason,created_at')
   .eq('company_id',companyId).order('created_at',{ascending:false}).limit(100);
  if(events.error) throw events.error;
  const [automation,failures]=await Promise.all([
   db.from('workforce_lifecycle_automation_settings').select('enabled,updated_at').eq('company_id',companyId).maybeSingle(),
   db.from('workforce_lifecycle_failures').select('workforce_id,error,attempted_at,attempts').eq('company_id',companyId)
  ]);
  if(automation.error) throw automation.error;
  if(failures.error) throw failures.error;
  const allowedIds=new Set(rows.map(r=>r.id));
  return reply({rows,stations:stations.map(s=>({id:s.id,code:s.station_code})),canManage,
   automation:{enabled:automation.data?.enabled===true,updatedAt:automation.data?.updated_at||null},
   failures:(failures.data||[]).filter(e=>allowedIds.has(e.workforce_id)),
   events:(events.data||[]).filter(e=>allowedIds.has(e.workforce_id))});
 } catch(error){return reply({error:error instanceof Error?error.message:'Unable to load lifecycle.'},error instanceof AccessError?error.status:503);}
}
export async function POST(request:Request) {
 try {
  if(request.headers.get('origin')!==new URL(request.url).origin) throw new AccessError('Reload the page before continuing.',403);
  const {auth,companyId,db,stations}=await context(true);
  const body=await request.json();
  if(body.confirmed!==true || !['inactivate','reactivate','offboard','rejoin'].includes(body.action)) throw new AccessError('Confirm a valid action.');
  if(typeof body.reason!=='string' || body.reason.trim().length<5 || body.reason.length>1000) throw new AccessError('Add a clear reason (5–1000 characters).');
  const result=await db.rpc('workforce_lifecycle_audit',{p_company:companyId});
  if(result.error) throw result.error;
  const row=(result.data as WorkforceLifecycleRow[]).find(r=>r.id===body.id && stations.some(s=>s.id===r.location_id));
  if(!row) throw new AccessError('This associate is outside your access.',403);
  if(!workforceLifecycleActions(row).includes(body.action)) throw new AccessError('This action is no longer available. Refresh the profile.');
  const changed=await db.rpc('workforce_lifecycle_transition',{p_company:companyId,p_workforce:row.id,p_action:body.action,
   p_actor:auth.userId,p_reason:body.reason.trim(),p_expected_updated_at:body.updatedAt,p_expected_version:body.version,p_automatic:false});
  if(changed.error) throw changed.error;
  return reply({result:changed.data});
 }catch(error){return reply({error:error instanceof Error?error.message:'Unable to update lifecycle.'},error instanceof AccessError?error.status:409);}
}

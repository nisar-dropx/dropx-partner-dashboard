import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadOpsWorkforceLocations } from '@/lib/ops-workforce-locations';
import { workforceStationPolicy } from '@/lib/workforce-register-policy';
import { callWorkforceAmazonWorker, workforceAmazonWorkerConfig } from '@/lib/workforce-amazon-worker';
import { deskProfileId, deskUuid, validateDeskAction } from '@/lib/amazon-da-desk-policy';
import type { AmazonDaProfile } from '@/lib/amazon-da-desk-types';
import {loadClientIdMappingsForWorkers,needsClientId,providerMappingFor,type ClientIdWorker} from '@/lib/workforce-client-id-queue';
import {loadClientIdPartnerStates} from '@/lib/workforce-client-id-partner';
import {dashboardDateInputValue} from '@/lib/date-format';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const reply = (body: unknown, status=200) => NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const columns = 'id,provider_id,associate_name,actor_name,actor_role,action,reason_code,remarks,expected_status,status,result_message,observed_status,created_at,updated_at,events:amazon_da_command_events(status,message,observed_status,created_at)';
class DeskError extends Error { constructor(message:string, readonly status=400){super(message);} }
async function context(stationId: string, write=false) {
  const auth = await getAuthorization();
  if (!auth) throw new DeskError('Sign in to continue.',401);
  if (!auth.companyId || !hasPermission(auth,'delivery_associates',write?'edit':'access') || (write && (auth.readOnly || auth.isPreview)))
    throw new DeskError('You do not have access to this action.',403);
  if (!supabaseAdmin) throw new DeskError('The onboarding service is unavailable.',503);
  if (!deskUuid.test(stationId)) throw new DeskError('Choose a station.');
  const stations = await loadOpsWorkforceLocations(auth.companyId,auth);
  if (!stations.some(s=>s.id===stationId && workforceStationPolicy(s).requiresStationEmail))
    throw new DeskError('This station is outside your access.',403);
  return {auth, companyId:auth.companyId, db:supabaseAdmin};
}
function worker<T>(operation:string,body:unknown) {
  return callWorkforceAmazonWorker<T>(`/api/admin/amazon/station-desk/${operation}`,{method:'POST',body:JSON.stringify(body)});
}
export async function GET(request:Request) {
  try {
    const params = new URL(request.url).searchParams;
    const stationId = params.get('station') || '';
    const {companyId, db} = await context(stationId);
    const view = params.get('view') || 'onboarding';
    const providerId = params.get('profile');
    if (providerId && !deskProfileId.test(providerId)) throw new DeskError('Select a valid Amazon profile.');
    if(view==='photo') {
      const ticket=params.get('ticket')||'';
      if(!providerId||!ticket||ticket.length>4096)throw new DeskError('Photo unavailable.',404);
      const config=workforceAmazonWorkerConfig();if(!config.configured)throw new DeskError('Photo unavailable.',404);
      const response=await fetch(`${config.baseUrl}/api/admin/amazon/station-desk/photo`,{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':config.adminKey},
        body:JSON.stringify({companyId,stationId,providerId,ticket}),cache:'no-store',signal:AbortSignal.timeout(20000)});
      const type=response.headers.get('content-type')||'';
      if(!response.ok||!['image/jpeg','image/png','image/webp','image/gif'].includes(type))return new Response(null,{status:404,headers:{'Cache-Control':'private, no-store'}});
      return new Response(response.body,{headers:{'Content-Type':type,'Cache-Control':'private, max-age=300','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
    }
    if (view === 'history') {
      // History stays with the original station even after an external Amazon transfer.
      let query = db.from('amazon_da_commands').select(columns).eq('company_id',companyId).eq('station_id',stationId).order('created_at',{ascending:false}).limit(100);
      if (providerId) query=query.eq('provider_id',providerId);
      const rows=await query;
      if(rows.error) throw rows.error;
      return reply({commands:rows.data});
    }
    if (providerId) return reply(await worker('profile',{companyId,stationId,providerId}));
    if (view === 'invite') {
      const [people,requests] = await Promise.all([
        db.from('workforce').select('id,full_name,dropx_id,email,onboarding_status,source_profile_type,source_profile_id,lifecycle_status,migration_state,location_id,stations(provider_id),designations(provider_mapping_required)').eq('company_id',companyId).eq('location_id',stationId).is('deleted_at',null).in('onboarding_status',['under_review','approved','active']).order('full_name').limit(500),
        db.from('workforce_amazon_invitation_requests').select('id,workforce_id,status,requested_at,error_message').eq('company_id',companyId).eq('station_id',stationId).order('requested_at',{ascending:false}).limit(100),
      ]);
      if(people.error || requests.error) throw new Error('Could not load invitation records.');
      const workers=people.data as unknown as (ClientIdWorker&{full_name:string;dropx_id:string|null;email:string|null})[];
      const mappings=await loadClientIdMappingsForWorkers(db,companyId,workers);
      const states=new Map(workers.map(p=>[p.id,providerMappingFor(p,mappings,dashboardDateInputValue())]));
      const partners=await loadClientIdPartnerStates(db,companyId,workers.filter(p=>needsClientId(p)&&!states.get(p.id)?.known).map(p=>p.id));
      return reply({people:workers.map(p=>({id:p.id,full_name:p.full_name,dropx_id:p.dropx_id,email:p.email,onboarding_status:p.onboarding_status,
        inviteBlocked:!needsClientId(p)?'This profile does not require an invitation.':states.get(p.id)?.current?'Amazon ID already linked.':states.get(p.id)?.known?'Amazon ID exists · review its mapping.':partners.has(p.id)?partners.get(p.id)!.instruction:null})),requests:requests.data});
    }
    if (!['onboarding','associates','offboarded'].includes(view)) throw new DeskError('Select a valid view.');
    return reply(await worker('list',{companyId,stationId,view,
      ...(params.has('pageSize')?{pageSize:24,offset:Math.max(0,Math.floor(Number(params.get('offset'))||0)),
        query:(params.get('query')||'').slice(0,100),status:(params.get('status')||'').slice(0,30),
        snapshot:params.get('snapshot')||'',fresh:params.get('fresh')==='1'}:{})}));
  } catch(error) { return reply({error:error instanceof Error ? error.message : 'Unable to load Amazon onboarding.'},error instanceof DeskError?error.status:503); }
}
export async function POST(request:Request) {
  try {
    const origin=request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) throw new DeskError('Reload this page before making changes.',403);
    const body=await request.json() as Record<string,unknown>;
    const stationId=String(body.stationId || '');
    const {auth,companyId,db}=await context(stationId,true);
    if(body.operation==='reconcile') {
      if(!deskUuid.test(String(body.id||''))) throw new DeskError('Select a recorded action.');
      const saved=await db.from('amazon_da_commands').select('id').eq('id',String(body.id)).eq('company_id',companyId).eq('station_id',stationId).maybeSingle();
      if(saved.error) throw saved.error;
      if(!saved.data) throw new DeskError('Action not found within your station access.',403);
      return reply(await worker('reconcile',{commandId:saved.data.id}));
    }
    let action: ReturnType<typeof validateDeskAction>;
    try { action=validateDeskAction(body); } catch(error) {throw new DeskError((error as Error).message);}
    const existing=await db.from('amazon_da_commands').select(`${columns},company_id,station_id,actor_id`).eq('id',action.id).maybeSingle();
    if(existing.error) throw existing.error;
    if(existing.data) {
      const row=existing.data;
      if(row.company_id!==companyId || row.station_id!==stationId || row.actor_id!==auth.userId || row.provider_id!==action.providerId || row.action!==action.action || row.reason_code!==action.reasonCode || row.remarks!==action.remarks || row.expected_status!==action.expectedStatus)
        throw new DeskError('This action reference already belongs to a different request.',409);
      // Replaying a browser POST never replays the Amazon mutation.
      return reply({command:row});
    }
    const profile=await worker<AmazonDaProfile>('profile',{companyId,stationId,providerId:action.providerId});
    if(profile.person.status!==action.expectedStatus) throw new DeskError('Amazon status changed. Refresh the profile.',409);
    if(action.action==='RESEND_INVITATION' ? !profile.canResend : !profile.options.some(o=>o.action===action.action && o.reasonCode===action.reasonCode))
      throw new DeskError('Amazon does not allow this action or reason right now.',409);
    const inserted=await db.from('amazon_da_commands').insert({
      id:action.id,company_id:companyId,station_id:stationId,provider_id:action.providerId,
      associate_name:profile.person.name,actor_id:auth.userId,actor_name:auth.fullName || auth.email || 'User',
      actor_role:auth.designationName || auth.roleName || auth.roleCode || 'User',
      action:action.action,reason_code:action.reasonCode,remarks:action.remarks,expected_status:action.expectedStatus,
    });
    if(inserted.error) {
      if(inserted.error.code==='23505') throw new DeskError('An action is already in progress or awaiting confirmation for this associate. Open History.',409);
      throw new Error('Could not record this action. Nothing was sent to Amazon.');
    }
    try { return reply(await worker('command',{commandId:action.id})); }
    catch { return reply({pending:true,message:'The action was recorded. Check History for the result before trying anything else.'},202); }
  } catch(error) { return reply({error:error instanceof Error?error.message:'Unable to process this action.'},error instanceof DeskError?error.status:503); }
}

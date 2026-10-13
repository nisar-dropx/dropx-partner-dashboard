import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { currentProviderMappingPageCode } from '@/lib/provider-mapping-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { mappingAuditForRow, type StoredMappingAuditRow, type StoredMappingEvent } from '@/lib/provider-mapping-audit';

export async function GET(request: Request) {
  const respond = (data: unknown, status = 200) => NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
  try {
    const auth = await getAuthorization();
    if (!auth) return respond({error:'Sign in to view mapping history.'},401);
    if (!auth.companyId || !hasPermission(auth,currentProviderMappingPageCode(),'access')) return respond({error:'Mapping access is required.'},403);
    if (!supabaseAdmin) return respond({error:'Mapping history is temporarily unavailable.'},503);
    const ids = [...new Set((new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > 100 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) return respond({error:'Select up to 100 saved mapping records.'},400);
    let query = supabaseAdmin.from('field_executive_provider_mappings').select('id,workforce_id,provider_id,provider_member_id,station_id,effective_from,created_by,created_at,updated_at').eq('company_id',auth.companyId).in('id',ids);
    if (!auth.hasAllLocationAccess && !auth.isMasterOwner && auth.roleCode !== 'OWNER') query = query.in('station_id',auth.locationScopeIds.length ? auth.locationScopeIds : ['00000000-0000-0000-0000-000000000000']);
    const mappings = await query;
    if (mappings.error) throw mappings.error;
    if (mappings.data.length !== ids.length) return respond({error:'One or more mappings are outside your permitted locations or no longer exist.'},403);
    const workers = [...new Set(mappings.data.map(row => row.workforce_id).filter(Boolean))];
    const events = workers.length ? await readAllRows(supabaseAdmin.from('workforce_joining_events').select('id,workforce_id,event_code,actor_id,actor_name,created_at,details').eq('company_id',auth.companyId).in('workforce_id',workers).like('event_code','provider_mapping_%').order('created_at',{ascending:false}).order('id')) : {data:[],error:null};
    if (events.error) throw events.error;
    const actorIds = [...new Set([...mappings.data.map(row => row.created_by),...(events.data ?? []).map(row => row.actor_id)].filter(Boolean))];
    const profiles = actorIds.length ? await supabaseAdmin.from('profiles').select('id,full_name').eq('company_id',auth.companyId).in('id',actorIds) : {data:[],error:null};
    if (profiles.error) throw profiles.error;
    const names = new Map<string,string>((profiles.data ?? []).map(profile => [profile.id,String(profile.full_name ?? '').trim()]));
    return respond({audit:Object.fromEntries(mappings.data.map(row => [row.id,mappingAuditForRow(row as StoredMappingAuditRow,(events.data ?? []) as StoredMappingEvent[],names)]))});
  } catch { return respond({error:'Could not load the update history. Please retry.'},503); }
}

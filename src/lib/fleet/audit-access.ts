import 'server-only';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { hasActiveFleetMembership } from '@/lib/fleet-control';
import { supabaseAdmin } from '@/lib/supabase-admin';
export async function auditAccess(auditId: string, edit: boolean | 'followup' = false) {
 const auth=await getAuthorization();
 if(!auth || !supabaseAdmin) throw new Error('Sign in to Fleet to access evidence.');
 const companyId=requireCompanyId(auth);
 if(edit && auth.readOnly) throw new Error('User preview is read-only. Exit preview before making changes.');
 if(!auth.isMasterOwner && !(await hasActiveFleetMembership(companyId,auth.userId))) throw new Error('Fleet access is not assigned.');
 const codes=edit==='followup' ? ['fleet_audits','fleet_maintenance'] : edit ? ['fleet_audits'] : ['fleet_audits','fleet_action_center','fleet_maintenance'];
 if(!auth.isMasterOwner && !codes.some(c=>hasPermission(auth,c,edit?'edit':'access'))) throw new Error('Audit permission denied.');
 const audit=await supabaseAdmin.from('fleet_audits').select('id,status,fleet_vehicles!inner(station_code)').eq('company_id',companyId).eq('id',auditId).single();
 if(audit.error) throw new Error('Audit not found.');
 const vehicle=Array.isArray(audit.data.fleet_vehicles)?audit.data.fleet_vehicles[0]:audit.data.fleet_vehicles;
 if(!auth.isMasterOwner && !auth.hasAllLocationAccess) {
  const stations=await supabaseAdmin.from('stations').select('station_code').eq('company_id',companyId).in('id',auth.locationScopeIds.length?auth.locationScopeIds:['00000000-0000-0000-0000-000000000000']);
  if(stations.error || !stations.data.some(s=>s.station_code===vehicle.station_code)) throw new Error('This vehicle is outside your assigned locations.');
 }
 if(edit===true && !['scheduled','in_progress'].includes(audit.data.status)) throw new Error('This audit is already completed.');
 return {companyId,userId:auth.userId};
}

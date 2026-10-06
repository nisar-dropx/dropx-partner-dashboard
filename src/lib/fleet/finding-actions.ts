import 'server-only';
import {getAuthorization} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {auditAccess} from './audit-access';
import {supabaseAdmin} from '@/lib/supabase-admin';
export async function findingAccess(findingId:string) {
 if(!/^[0-9a-f-]{36}$/i.test(findingId))throw new Error('Choose a valid finding.');
 const auth=await getAuthorization();
 if(!auth||auth.readOnly)throw new Error('Sign in with edit access. User preview is read-only.');
 const company=requireCompanyId(auth);
 const f=await supabaseAdmin!.from('fleet_audit_findings').select('audit_id,company_id').eq('id',findingId).eq('company_id',company).single();
 if(f.error)throw new Error('Finding not available.');
 const access=await auditAccess(f.data.audit_id,'followup');
 if(access.companyId!==f.data.company_id)throw new Error('Finding access denied.');
 return {...access,auditId:f.data.audit_id};
}
export async function saveFindingUpdate(body:Record<string,unknown>) {
 const findingId=String(body.findingId||'');
 const {companyId,userId}=await findingAccess(findingId);
 const result=await supabaseAdmin!.rpc('fleet_save_finding_update',{
  p_company:companyId,p_finding:findingId,p_actor:userId,p_event:body.eventId,p_expected:body.expectedUpdatedAt,
  p_status:body.status,p_note:body.resolutionNote,p_action:body.actionRequired,p_owner:body.responsibleName,
  p_due:body.dueDate,p_severity:body.severity,p_uploads:Array.isArray(body.uploadIds)?body.uploadIds:[]
 });
 if(result.error)throw new Error(result.error.message);
 return {ok:true,eventId:result.data};
}

import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
export async function performPayoutReview(form:FormData,portal:'workforce'|'ops'){
 const auth=await requirePagePermission(portal==='ops'?'ops_workforce_losses':'workforce_payout_disputes','edit');
 if(auth.readOnly||!supabaseAdmin)throw new Error('Editing is unavailable.');
 const t=(k:string)=>String(form.get(k)||'').trim(),base={p_company:requireCompanyId(auth),p_actor:auth.userId,p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds};
 let result;
 if(t('operation')==='retry_notice'){
  const publicationId=t('publication_id');
  const publication=await supabaseAdmin.from('workforce_payout_publications').select('publication_kind').eq('company_id',base.p_company).eq('id',publicationId).maybeSingle();
  if(publication.error||!publication.data)throw new Error('Payout publication not found.');
  if(publication.data.publication_kind==='worksheet'&&!auth.hasAllLocationAccess)throw new Error('Company-wide location access is required to retry this payout notification.');
  result=await supabaseAdmin.rpc('workforce_retry_payout_notice',{...base,p_id:publicationId});
 }
 else if(t('operation')==='reply')result=await supabaseAdmin.rpc('workforce_update_payout_dispute',{...base,p_dispute:t('dispute_id'),p_actor_name:auth.fullName||auth.email||'Authorised reviewer',p_portal:portal,p_status:t('status'),p_message:t('message'),p_correction:t('correction_id')||null});
 else if(t('operation')==='propose'){
  const kind=t('kind'),keys=kind==='counts'?['totalDelivery','customerReturn','mfn','mfnReturn']:['amount'];
  if(keys.some(k=>t(k)===''||!Number.isFinite(Number(t(k)))))throw new Error('Complete all values required for this correction.');
  result=await supabaseAdmin.rpc('workforce_propose_payout_correction',{...base,p_run:t('run_id'),p_workforce:t('workforce_id'),p_portal:portal,p_source:t('source_id'),p_kind:kind,p_payload:Object.fromEntries(keys.map(k=>[k,Number(t(k))])),p_reason:t('reason'),p_dispute:t('dispute_id')||null});
 }else if(t('operation')==='review'&&portal==='workforce')result=await supabaseAdmin.rpc('workforce_review_payout_correction',{...base,p_id:t('correction_id'),p_decision:t('decision'),p_remarks:t('message')});
 else throw new Error('Unsupported review action.');
 if(result.error)throw new Error(result.error.message);
}

'use server';
import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {canAccessDailyCodPending} from '@/lib/ops-pulse/cod-pending-access';
import {canReturnCodSlip} from '@/lib/ops-pulse/cod-return-policy';
import {canReviewCodSlip,manualReviewReason} from '@/lib/ops-pulse/cod-review-policy';
import {supabaseAdmin} from '@/lib/supabase-admin';
export async function reviewCodSlip(_state:{ok:boolean;message:string},form:FormData){
 try{
  const auth=await requirePagePermission('cod_reports','access'),company=requireCompanyId(auth);
  if(!canAccessDailyCodPending(auth)||!canReviewCodSlip(auth))throw new Error('You cannot review COD slips.');
  if(!supabaseAdmin)throw new Error('Database unavailable');
  const id=String(form.get('submission_id')||''),version=Number(form.get('proof_version'));
  const decision=String(form.get('decision')||'') as keyof typeof manualReviewReason;
  const note=String(form.get('reason')||'').trim();
  if(!Number.isInteger(version)||version<1||!(decision in manualReviewReason))throw new Error('Choose a valid review decision.');
  if(form.get('review_confirmed')!=='yes')throw new Error('Confirm that all three slip controls were checked.');
  if(decision==='Not valid'&&(note.length<3||note.length>300))throw new Error('Enter the correction reason (3–300 characters).');
  if(note.length>300)throw new Error('Keep the review note within 300 characters.');
  const existing=await supabaseAdmin.from('cod_submissions').select('location_id,proof_version,returned_at').eq('company_id',company).eq('id',id).single();
  if(existing.error||!existing.data)throw new Error('Submission not found.');
  if(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(existing.data.location_id))throw new Error('Submission is outside your station access.');
  if(existing.data.returned_at)throw new Error('This slip has already been returned.');
  if(Number(existing.data.proof_version)!==version)throw new Error('This slip was replaced. Refresh and review the latest version.');
  const reviewedAt=new Date().toISOString(),reviewer=auth.fullName||auth.email||'COD reviewer';
  const summary=decision==='Valid'?manualReviewReason.Valid:note;
  const result=await supabaseAdmin.from('cod_submissions').update({
   ai_status:decision,ai_summary:summary,
   ai_result:{source:'manual',controls:['CMS / bank deposit slip','Deposited amount','Bank / CMS seal'],reviewer_id:auth.userId,reviewer_name:reviewer,reviewed_at:reviewedAt,proof_version:version},
   proof_checked_at:reviewedAt,proof_check_token:null,proof_check_started_at:null,
   last_updated_by:auth.userId,last_updater_name:reviewer
  }).eq('company_id',company).eq('id',id).eq('proof_version',version).is('returned_at',null).select('id').maybeSingle();
  if(result.error)throw new Error(result.error.message);if(!result.data)throw new Error('This slip changed. Refresh and try again.');
  for(const path of ['/cod/pending','/cod/submission','/ops-pulse/cod/pending','/ops-pulse/cod/submission'])revalidatePath(path);
  return {ok:true,message:decision==='Valid'?'Marked valid.':'Review saved. Return the slip if the station must re-upload.'};
 }catch(error){return {ok:false,message:error instanceof Error?error.message:'Unable to review slip.'};}
}
export async function returnCodSlip(_state:{ok:boolean;message:string},form:FormData){
 try{
  const auth=await requirePagePermission('cod_reports','access'),company=requireCompanyId(auth);
  if(!canAccessDailyCodPending(auth)||!canReturnCodSlip(auth))throw new Error('You cannot return COD slips.');
  if(!supabaseAdmin)throw new Error('Database unavailable');
  const id=String(form.get('submission_id')||''),version=Number(form.get('proof_version')),reason=String(form.get('reason')||'').trim();
  if(!Number.isInteger(version)||version<1||reason.length<3||reason.length>300)throw new Error('Enter a short reason (3–300 characters).');
  const existing=await supabaseAdmin.from('cod_submissions').select('location_id').eq('company_id',company).eq('id',id).single();
  if(existing.error||!existing.data||(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(existing.data.location_id)))throw new Error('Submission is outside your station access.');
  const result=await supabaseAdmin.rpc('return_cod_slip',{p_company:company,p_submission:id,p_version:version,p_actor:auth.userId,p_reason:reason});if(result.error)throw new Error(result.error.message);
  for(const path of ['/cod/pending','/cod/submission','/ops-pulse/cod/pending','/ops-pulse/cod/submission'])revalidatePath(path);
  return {ok:true,message:'Returned. Notification queued for the station and cluster manager.'};
 }catch(error){return {ok:false,message:error instanceof Error?error.message:'Unable to return slip.'};}
}

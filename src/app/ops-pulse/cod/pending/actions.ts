'use server';
import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {canAccessDailyCodPending} from '@/lib/ops-pulse/cod-pending-access';
import {canReturnCodSlip} from '@/lib/ops-pulse/cod-return-policy';
import {supabaseAdmin} from '@/lib/supabase-admin';
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

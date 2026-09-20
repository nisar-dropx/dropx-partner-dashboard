'use server';
import {redirect} from 'next/navigation';import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';import {requireCompanyId} from '@/lib/company-scope';import {supabaseAdmin} from '@/lib/supabase-admin';
import {parseWorkforceLoss} from '@/lib/ops-pulse/workforce-loss';
export async function submitLoss(form:FormData){
 const auth=await requirePagePermission('ops_workforce_losses','add'),query=new URLSearchParams();
 try{
  if(auth.readOnly)throw new Error('Preview mode is read-only.');if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const result=await supabaseAdmin.rpc('workforce_submit_station_loss',{...parseWorkforceLoss(form,today),p_company:requireCompanyId(auth),p_actor:auth.userId,p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds});
  if(result.error)throw new Error(result.error.message);
  query.set('notice','Claim recorded for independent Workforce approval. No deduction is payable until approved.');revalidatePath('/ops-pulse/attendance/workforce-losses');
 }catch(error){query.set('error',error instanceof Error?error.message:'Unable to submit the claim.');}
 redirect(`/attendance/workforce-losses?${query}`);
}

'use server';
import {redirect} from 'next/navigation';import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';import {requireCompanyId} from '@/lib/company-scope';import {supabaseAdmin} from '@/lib/supabase-admin';
import {parseMileageClaim} from '@/lib/workforce-mileage-input';
export async function submitMileage(form:FormData){
 const auth=await requirePagePermission('ops_workforce_mileage','add'),query=new URLSearchParams();
 try{
  if(auth.readOnly)throw new Error('Preview mode is read-only.');if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const result=await supabaseAdmin.rpc('workforce_submit_mileage',{...parseMileageClaim(form),p_company:requireCompanyId(auth),p_actor:auth.userId,p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds});
  if(result.error)throw new Error(result.error.message);query.set('notice','Evidence submitted for independent Workforce review. No payable earning has been created.');revalidatePath('/ops-pulse/attendance/workforce-mileage');
 }catch(e){query.set('error',e instanceof Error?e.message:'Unable to submit mileage.');}
 redirect(`/attendance/workforce-mileage?${query}`);
}

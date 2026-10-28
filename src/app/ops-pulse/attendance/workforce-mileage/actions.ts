'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {isCompanyOwner,requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {parseMileageClaim} from '@/lib/workforce-mileage-input';

function redirectMileage(query:URLSearchParams):never{
 redirect(`/attendance/workforce-mileage?${query}`);
}

export async function submitMileage(form:FormData){
 const auth=await requirePagePermission('ops_workforce_mileage','add');
 const query=new URLSearchParams();
 try{
  if(auth.readOnly)throw new Error('Preview mode is read-only.');
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const result=await supabaseAdmin.rpc('workforce_submit_mileage',{
   ...parseMileageClaim(form),
   p_company:requireCompanyId(auth),
   p_actor:auth.userId,
   p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds
  });
  if(result.error)throw new Error(result.error.message);
  query.set('notice','Evidence submitted for independent Workforce review. No payable earning has been created.');
  revalidatePath('/ops-pulse/attendance/workforce-mileage');
 }catch(e){query.set('error',e instanceof Error?e.message:'Unable to submit mileage.');}
 redirectMileage(query);
}

export async function createMileagePolicy(form:FormData){
 const auth=await requirePagePermission('ops_workforce_mileage','access');
 const query=new URLSearchParams();
 try{
  if(auth.readOnly)throw new Error('Preview mode is read-only.');
  if(!isCompanyOwner(auth))throw new Error('Only a company owner can save station mileage policies.');
  await requirePagePermission('workforce_rate_cards','edit');
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const value=(key:string)=>String(form.get(key)??'').trim();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
  if(!uuid.test(value('station_id')))throw new Error('Choose a station.');
  if(value('name').length<3||value('name').length>120)throw new Error('Enter a policy name between 3 and 120 characters.');
  const rate=Number(value('rate_per_km'));
  const maxKm=Number(value('maximum_daily_km'));
  if(!Number.isFinite(rate)||rate<=0||rate>1000000)throw new Error('Enter a positive rate per kilometre.');
  if(!Number.isFinite(maxKm)||maxKm<=0||maxKm>10000)throw new Error('Enter a positive daily kilometre limit.');
  if(!date(value('effective_from'))||!date(value('effective_to')))throw new Error('Choose valid effective dates.');
  if(value('effective_to')<value('effective_from'))throw new Error('Effective through cannot precede effective from.');
  if(value('policy_reference').length<3||value('policy_reference').length>1000)throw new Error('Enter the approved terms reference.');
  const result=await supabaseAdmin.rpc('workforce_create_mileage_policy',{
   p_company:requireCompanyId(auth),
   p_actor:auth.userId,
   p_station:value('station_id'),
   p_name:value('name'),
   p_rate:rate,
   p_max_km:maxKm,
   p_from:value('effective_from'),
   p_to:value('effective_to'),
   p_reference:value('policy_reference'),
   p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds
  });
  if(result.error)throw new Error(result.error.message);
  query.set('notice','Station mileage policy saved. Exceptional claims can now use these terms.');
  revalidatePath('/ops-pulse/attendance/workforce-mileage');
 }catch(e){query.set('error',e instanceof Error?e.message:'Unable to save the mileage policy.');}
 redirectMileage(query);
}

export async function reviewMileage(form:FormData){
 const auth=await requirePagePermission('ops_workforce_mileage','edit');
 const query=new URLSearchParams();
 try{
  if(auth.readOnly)throw new Error('Preview mode is read-only.');
  if(!isCompanyOwner(auth))throw new Error('Only a company owner can review mileage claims.');
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const value=(key:string)=>String(form.get(key)??'').trim();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
  const decision=value('decision');
  if(!uuid.test(value('claim_id')))throw new Error('Choose a claim to review.');
  if(decision!=='approved'&&decision!=='rejected')throw new Error('Choose approve or reject.');
  if(value('review_remarks').length<10||value('review_remarks').length>2000)throw new Error('Enter verification notes of at least 10 characters.');
  if(!date(value('posting_date')))throw new Error('Choose a valid payroll posting date.');
  const company=requireCompanyId(auth);
  const claim=await supabaseAdmin.from('workforce_mileage_claims')
   .select('id,reported_by,work_date,station_id,adjustment_id,adjustment:workforce_adjustments(id,status)')
   .eq('company_id',company)
   .eq('id',value('claim_id'))
   .maybeSingle();
  if(claim.error)throw new Error(claim.error.message);
  if(!claim.data)throw new Error('That mileage claim could not be found.');
  if(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(claim.data.station_id))throw new Error('That claim is outside your station access.');
  if(claim.data.reported_by===auth.userId)throw new Error('A different reviewer must verify this claim.');
  const adjustment=Array.isArray(claim.data.adjustment)?claim.data.adjustment[0]:claim.data.adjustment;
  if(!adjustment||adjustment.status!=='pending')throw new Error('This claim is no longer awaiting review.');
  if(value('posting_date')<claim.data.work_date)throw new Error('Posting cannot precede the work date.');
  const updated=await supabaseAdmin.from('workforce_adjustments').update({
   status:decision,
   effective_date:value('posting_date'),
   reviewed_by:auth.userId,
   reviewed_at:new Date().toISOString(),
   review_remarks:value('review_remarks')
  }).eq('company_id',company).eq('id',claim.data.adjustment_id).eq('status','pending').select('id').maybeSingle();
  if(updated.error)throw new Error(updated.error.message);
  if(!updated.data)throw new Error('This claim is no longer awaiting review.');
  query.set('notice',decision==='approved'?'Mileage evidence approved for the selected payroll posting date.':'Mileage claim rejected. Corrected evidence needs a new reference.');
  revalidatePath('/ops-pulse/attendance/workforce-mileage');
 }catch(e){query.set('error',e instanceof Error?e.message:'Unable to save the mileage review.');}
 redirectMileage(query);
}

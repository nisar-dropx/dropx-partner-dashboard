import 'server-only';
import type {AuthorizationContext} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
export async function manageWorkforceHold(auth:AuthorizationContext,form:FormData,reviewer:boolean){
  if(auth.readOnly)throw new Error('Preview mode is read-only.');
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const value=(name:string)=>String(form.get(name)??'').trim();
  const action=value('action');
  if(!['create','request_release','release'].includes(action))throw new Error('Choose a valid hold action.');
  if(action==='create'){
    for(const key of ['period_start','period_end']) {const raw=value(key);if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||new Date(`${raw}T00:00:00Z`).toISOString().slice(0,10)!==raw)throw new Error('Choose valid hold dates.');}
    if(value('reason').length<5||value('reason').length>2000||value('reference').length<3||value('reference').length>250)throw new Error('Provide a reason and unique case reference.');
  }
  const result=await supabaseAdmin.rpc('workforce_manage_payment_hold',{p_company:requireCompanyId(auth),p_actor:auth.userId,p_id:value('hold_id')||null,p_workforce:value('workforce_id')||null,p_action:action,p_locations:auth.hasAllLocationAccess?null:auth.locationScopeIds,p_reviewer:reviewer,
    p_payload:{period_start:value('period_start'),period_end:value('period_end'),reason:value('reason'),reference:value('reference'),note:value('note')}});
  if(result.error)throw new Error(result.error.message);
  return action==='create'?'Payment hold placed. Earnings are retained; no deduction has been made.':action==='release'?'Hold released with reviewer audit. Recalculate affected draft payroll before submission.':'Release requested. The hold remains active until an independent Workforce reviewer releases it.';
}

import {readAllRows} from '../../../../src/lib/supabase-pagination.ts';
import type {WorkforceLossRecoveryLine} from '../../../../src/lib/workforce-loss-recovery.ts';

/** Caller authorizes the canonical worker first. Scope before PostgREST applies its row cap. */
export async function loadOwnLossDue(db:any,companyId:string,workerId:string,month:string):Promise<WorkforceLossRecoveryLine[]> {
  const result=await readAllRows(db.rpc('nl_loss_recovery_due',{
    p_company:companyId,p_salary_month:month,p_target:'workforce'
  },{get:true}).eq('worker_id',workerId).order('recovery_key'));
  if(result.error)throw new Error('Your loss deductions could not be verified. Please retry.');
  return (result.data??[]).filter(row=>row.worker_id===workerId);
}

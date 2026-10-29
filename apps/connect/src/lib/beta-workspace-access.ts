import type { SupabaseClient } from '@supabase/supabase-js';
import { betaLifecycleEnabled, betaLifecycleSummary } from './beta-lifecycle.ts';
import { verifiedBetaSnapshot } from './beta-verification.ts';

type Candidate = {id:string;company_id:string;alias_email:string|null;continuation_status?:string|null;closed_at?:string|null;inbox_status?:string|null};
/** Only the explicit pilot may open the read-only beta workspace. Canonical API access stays gated. */
export async function loadBetaWorkspaceAccess(db:SupabaseClient,candidate:Candidate) {
  if(!candidate.alias_email||!betaLifecycleEnabled(candidate.company_id,candidate.id)||candidate.closed_at||candidate.inbox_status==='suspended'||candidate.continuation_status==='not_continuing')return false;
  try {
    const [snapshot,invitation,cases]=await Promise.all([
      db.from('workforce_beta_verification_snapshots').select('amazon_profile_id,identity_email,operational_status,lsc_observed_at').eq('company_id',candidate.company_id).eq('candidate_id',candidate.id).maybeSingle(),
      db.from('workforce_amazon_invitation_requests').select('external_reference').eq('company_id',candidate.company_id).eq('email_pilot_candidate_id',candidate.id).order('requested_at',{ascending:false}).limit(1).maybeSingle(),
      db.from('workforce_beta_verification_cases').select('id').eq('company_id',candidate.company_id).eq('candidate_id',candidate.id).eq('status','offboarded').limit(1)
    ]);
    if(snapshot.error||invitation.error||cases.error||cases.data?.length)return false;
    const live=verifiedBetaSnapshot(snapshot.data,candidate.alias_email,invitation.data?.external_reference);
    return betaLifecycleSummary({stage:"",lifecycleEnhanced:true,isolatedBeta:true,operationalStatus:live?.operational_status,sourceStatus:{amazonUpdatedAt:live?.lsc_observed_at}}).betaWorkspaceActive;
  } catch { return false; }
}

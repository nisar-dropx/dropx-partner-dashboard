import "server-only";
import {supabaseAdmin} from "./supabase-admin";
import type {AuthorizationContext} from "./authorization";
import {loadDisputeEvidence} from "./payout-dispute-evidence";
import {refreshWorkforcePayoutPublicationJobs} from "./workforce-payout-publication-refresh";
import {notifyAssociateOfPayoutDispute} from "./payout-dispute-notifications";
function systemScope(companyId:string,stationId:string):AuthorizationContext{return {companyId,companyCode:null,companyName:null,email:null,effectiveRoleIds:[],fullName:"Approved dispute application",hasAllLocationAccess:false,isMasterCompany:false,isMasterOwner:false,locationScopeIds:[stationId],permissions:{},roleCode:null,roleId:null,roleName:null,userId:"00000000-0000-0000-0000-000000000000"};}
export async function processApprovedDisputes(input:{companyId?:string;disputeId?:string;authorization?:AuthorizationContext;deadlineAtMs?:number;verifyOnly?:boolean}={}){
 if(!supabaseAdmin)throw Error("Database unavailable.");
 const deadline=input.deadlineAtMs??Date.now()+200_000;
 let q=supabaseAdmin.from("workforce_dispute_application_jobs").select("*").in("state",input.verifyOnly?["awaiting_publication"]:["queued","blocked","awaiting_publication"]).or("state.eq.awaiting_publication,attempts.lt.3").order("updated_at").limit(input.disputeId?1:5);
 if(input.companyId)q=q.eq("company_id",input.companyId);if(input.disputeId)q=q.eq("dispute_id",input.disputeId);
 const jobs=await q;if(jobs.error)throw Error("Dispute application queue is unavailable.");
 const results=[];
 for(const job of jobs.data??[]){
  if(Date.now()>deadline-15_000)break;
  if(job.state==="blocked"&&job.attempts>=3)continue;
  try {
  const dispute=await supabaseAdmin.from("workforce_payout_disputes").select("*").eq("company_id",job.company_id).eq("id",job.dispute_id).single();
  if(dispute.error)continue;const d=dispute.data;
  const publication=await supabaseAdmin.from("workforce_payout_publications").select("*").eq("company_id",job.company_id).eq("id",d.publication_id).single();
  if(publication.error)continue;const p=publication.data;
  const auth=input.authorization??systemScope(job.company_id,d.station_id);
  let state=job.state;
  if(state!=="awaiting_publication"){
   const evidence=await loadDisputeEvidence(job.company_id,d,p,auth);
   if(evidence.sourceError||evidence.digest!==d.correction_plan?.evidence_digest){
    await supabaseAdmin.rpc("workforce_pause_dispute_application",{p_company:job.company_id,p_dispute:d.id,p_message:evidence.sourceError||"Source records changed after Finance approval. Return for fresh review before applying."});
    results.push({id:d.id,state:"blocked"});continue;
   }
   const applied=await supabaseAdmin.rpc("workforce_apply_approved_dispute",{p_company:job.company_id,p_dispute:d.id});
   if(applied.error){results.push({id:d.id,state:"retry",error:applied.error.message});continue;}
   state=applied.data.state;
  }
  if(state==="awaiting_publication"){
   if(!input.verifyOnly)await refreshWorkforcePayoutPublicationJobs({authorization:auth,companyId:job.company_id,payoutRows:[{workforceId:d.workforce_id,stationId:d.station_id}],periodStart:p.period_start,periodEnd:p.period_end,deadlineAtMs:deadline,limit:5});
   const verified=await supabaseAdmin.rpc("workforce_verify_dispute_application",{p_company:job.company_id,p_dispute:d.id});
   if(verified.error){results.push({id:d.id,state:"awaiting_publication",error:verified.error.message});continue;}
   state=verified.data.state;
   if(state==="completed"){
    const saved=await supabaseAdmin.from("workforce_payout_disputes").select("*").eq("company_id",job.company_id).eq("id",d.id).single();
    if(saved.data)try{await notifyAssociateOfPayoutDispute({action:"complete_processing",companyId:job.company_id,dispute:saved.data});}catch(e){console.error("Dispute completion notification failed",e);}
   }
  }
  results.push({id:d.id,state});
  } catch(error) {
   const message=error instanceof Error?error.message:"Source verification failed.";
   // Isolate failures so one unavailable source cannot starve other approved requests.
   if(job.state!=="awaiting_publication")await supabaseAdmin.rpc("workforce_pause_dispute_application",{p_company:job.company_id,p_dispute:job.dispute_id,p_message:message});
   results.push({id:job.dispute_id,state:"needs_attention",error:message});
  }
 }
 return results;
}
